# Leo Link：经中继的端到端加密（relay e2e v1）

手机 ↔ Mac 有两条路：直连（Tailscale Serve 的 HTTPS，TLS 直到 Mac 本机）和经中继（`src/mac/leoagent/relay.py`，
前面还有 Cloudflare 隧道）。经中继时以前只有到中继为止的 TLS：中继进程和 Cloudflare 边缘能看到请求明文
（会话内容、远程登录的 API key / 授权码、看屏 SDP……）。v1 让经中继的**内容**对中继不可见，用户不多做任何一步，
新旧版本两端互通，任何一处不支持都退回明文。

实现：Mac `packages/desktop/src/host/leo/link/relayE2E.ts`（+ `bridge.ts` 的 `/e2e` 分发、`index.ts` 载入钥匙、
`pairing.ts` 配对码字段）；iOS `Shared/RelayE2E.swift`（密码学与线格式）、`Agent/Gateway/LeoAgentRelayE2E.swift`
（中继腿接线）、`GatewayHostStore`（公钥存处）、`Shared/ShareMacTarget.swift`（分享扩展）；relay.py 不解析信封。

## 现有链路（改动前读到的事实）

- relay.py `forward()`：`/relay/api/m/<机器>/<tail>` 一律转发。`GET` 且 tail 含 `/events` 走流（`stream_open` →
  Mac 逐条 `stream_data`，中继只按子串 `"message.delta"` / `"journal.status"` 认可合并的帧），其余一问一答：
  `request.json()` 原样塞进 `http` 帧的 `body`，Mac 的 `resp.body` / `status` 原样回给手机。请求头只转
  `X-Leo-Request-Id`（`request_id`）和中继自己算出的 `caller`。离线排队只认 `POST /harness/sessions`、`…/send`。
- Mac `RelayLink`：`http` → `LinkBridge.handle()`，`stream_open` → `LinkBridge.stream()`；调用方身份来自中继帧。
- 直连 `directServer.ts`：grant token + `X-Leo-Device-ID` 鉴权；iOS 每 120 秒用直连 `GET /v1/capabilities`
  核对 `device.deviceId` 与配对时一致（`LeoAgentRouting.directRequest`）。直连描述符和 grant 本身是经中继
  `POST /direct-grants` 领的。
- iOS 所有经中继的 harness 请求都走 `LeoAgentClient.routedData / routedBytes`（先直连后中继，`RelayRootRouter`
  在多个中继入口间回落）；扫码 `RelayPairPayload.parse` 用 JSONSerialization，未知字段忽略（Android / 鸿蒙同样宽容）。

## 设计

### 谁拥有密钥

| 钥匙 | 所有者 | 存处 | 生命周期 |
| --- | --- | --- | --- |
| Mac 静态 X25519 | Mac（唯一） | `~/.leoagent/link/relay-e2e-key.json`（0600，`{"v":1,"private_key":b64url}`） | 首启生成；文件坏了不自动重建（重建会让已固定的手机全部退回明文），删掉才重新生成 |
| Mac 公钥副本 | 手机（每台主机一份） | `GatewayHost.relayE2EKey` + `relayE2EKeySource`（UserDefaults；公钥不是秘密） | 见「公钥固定」 |
| 请求临时 X25519 | 手机 | 只在内存，一个请求一把 | 请求结束即丢 |

手机**没有**静态钥匙：每个请求现生成临时钥匙（相当于 Noise `N` 模式）。不需要登记手机公钥、不需要持久化计数器，
nonce 天然不复用。代价是每请求一次 X25519（几十微秒）。

### 线格式

```
shared   = X25519(临时私钥, Mac 公钥)                     // Mac 侧：X25519(Mac 私钥, 临时公钥)
okm      = HKDF-SHA256(ikm=shared, salt=临时公钥‖Mac 公钥, info="leobot-relay-e2e-v1", L=64)
k_req    = okm[0..32]   手机→Mac          k_resp = okm[32..64]   Mac→手机
nonce(n) = 00000000 ‖ uint64_be(n)
AEAD     = ChaCha20-Poly1305，AAD 请求 "leobot-e2e-req"、响应 "leobot-e2e-resp"；密文 = ct‖tag，base64url 无填充
```

- 请求：`POST <机器前缀>/e2e`，body `{"v":1,"k":<临时公钥>,"c":seal(k_req,0,内层)}`；
  内层 `{"method","path"(含查询),"body"?,"request_id"?}`。外层保留 `Authorization`、`X-Leo-Request-Id`、`X-Leo-Queue`。
- 响应：`{"v":1,"c":seal(k_resp,0,{"status","body"})}`。**外层状态码 = 内层状态码**（204/304 记 200）：中继离线排队
  回执只看 `http_status`，iOS 的 HarnessOutbox 要靠它分辨「Mac 拒了」。代价是状态码对中继可见（以前也可见）。
- 流：`GET <机器前缀>/e2e/events?v=1&k=…&c=…`（路径含 `/events`，老中继也按流转发）。第 0 帧是
  `seal(k_resp,0,{"type":"e2e.open"})`，之后每条事件依次用计数 1、2、3…；帧格式 `data: {"v":1,"c":…}`。
  密文不含 `"message.delta"`，中继不会去合并。
- 跨端向量（固定私钥 32×0x01 / 32×0x02）写死在 `relayE2E.test.ts` 与 `MinisTests/RelayE2ETests.swift`，两边逐字节比对。

### Mac 处理（`LinkBridge`）

`handle()`：撤销检查之后、白名单之前，`POST /e2e` 交给 `RelayE2E.handle`：解信封 → 拒绝重放 → 内层路径不得再是
`/e2e*` → 用内层请求**重新调用 `handle()`**（调用方、transport 沿用外层，白名单 / 操作回执 / 全自动规则一处不变）→
加密 `{status, body}`。解不开回明文 `400 {"error":{"code":"e2e_rejected"}}`，重放回 `409 e2e_replay`，都不含业务内容。
`stream()`：`/e2e/events` 同理，内层必须是 GET 事件流；解不开 / 重放就一帧都不发。

### 重放与篡改

- 请求：Mac 进程内记最近 2 万个临时公钥，同一个信封第二次到达回 409（中继重投排队项时也是这条：iOS 收到 409
  不当定论，照旧查 `/operations/<id>` 回执）。Mac 重启后集合清空：写操作仍由操作回执按 `request_id` 去重，
  读操作被重放时对方也读不到结果。
- 响应：钥匙由本请求的临时公钥派生，换成别的请求的响应必然解不开。
- 流：计数严格递增，中继丢帧 / 换序 / 重放 / 改内容，下一帧就解不开 → iOS 抛错断开，按 `after=seq` 重连补齐。

### 公钥固定（零额外步骤）

| 来源 | 何时 | 可信度 | 能替换 |
| --- | --- | --- | --- |
| `qr` | 扫 Mac 出的配对码（`leoagent-body:v2|{…,"e2e":<公钥>}`） | 高：码在 Mac 屏幕上 | 任何来源 |
| `direct` | 直连探测 `GET /v1/capabilities`（`relay_e2e.public_key`）且设备 id 核对通过 | 高：TLS 到 Mac 本机 | 任何来源 |
| `relay` | 经中继**明文**拿到的 capabilities，且之前没固定过 | 首次信任 | 只能填空或替换同样来自 `relay` 的 |

已配对的老手机：任何一次直连成功就固定；从不直连的，第一次经中继拿 capabilities 时首次信任，之后就是加密的。
首次信任在被动观察（中继日志、Cloudflare 边缘）面前和扫码一样有效；它防不了「第一次就被主动替换公钥」——
这和下面的降级一样，是「风险只提示不加步骤」的取舍。

### 回退（谁先不支持就退回明文，并标「中继：未加密」）

```
手机有公钥? ──否──► 明文（同以前）
  │是
  ▼
POST /e2e ──► 中继 ──► Mac
  ├─ 信封、解得开 ──────────────► 用内层响应；标「中继：端到端加密」
  ├─ 信封、解不开（被篡改）──────► 明文重发（同 request_id，Mac 回执去重）；10 分钟内不再试
  ├─ 404（旧 Mac 不认 /e2e）─────► 明文重发；10 分钟内不再试
  ├─ 400 e2e_rejected（钥匙不对）► 明文重发；10 分钟内不再试（等直连 / 扫码换上新公钥）
  ├─ 502 且原请求带 X-Leo-Queue ─► 明文重发（旧中继不排 /e2e，保住离线排队；新中继会直接排信封）
  └─ 其余（401、离线 502、202 排队、429）► 中继自己的回答，原样交回
流：200 但一帧没有就结束 ──► 旧 Mac / 解不开 ──► 改开明文流接着给；非 200 原样交回
```

直连路径完全不变。分享扩展：有公钥时先发 `/e2e`，被判回退才发同编号的明文；加密那条网络失败就不再发明文。

### 兼容矩阵

| | 旧 Mac | 新 Mac |
| --- | --- | --- |
| 旧 iOS | 明文 | 明文（`/e2e` 只是多一条路由；配对码 / capabilities 多的字段被忽略） |
| 新 iOS | 404 / 空流 → 明文 | 加密 |

relay.py 不需要升级就能转发 `/e2e`、`/e2e/events`；部署本次的 relay.py 后多了「Mac 离线时排队 `/e2e`」（VERSION 未改，仍是 0.2.1）。

## relay.py 改动

- `_queueable`：`POST /e2e` 与建任务 / 发送一样可排队（手机只在原请求可排队时才带 `X-Leo-Queue`）。
- `DELETE /relay/api/device/activity-token` body `{"token":hex}`：客户端钥匙鉴权；token 登记在别的设备名下回 404；
  摘掉 APNs 登记、Live Activity 卡片规划、设备名下的 `push_tokens`；幂等（`{"ok":true,"removed":bool}`）。
  iOS 在同一张卡的 update token 轮换后调用一次（`AgentLiveActivityManager.observePushToken`），旧中继 404 就是以前的行为。

## 不做

- 不对直连再加一层（已是 TLS 到 Mac 本机）。
- 不隐藏元数据：哪台 Mac、什么时候、多大、状态码、是不是流，中继照样看得到。
- 不防主动攻击下的降级：中继故意回 404 / 改密文就能让手机退回明文（界面会标「未加密」）。要防就得「只走加密」，
  与「方便为先」冲突，第二波明确不做。
- 中继自己的接口（`/relay/api/events`、推送登记、排队查询、藏宝阁同步）不在机器前缀下，不加密。
