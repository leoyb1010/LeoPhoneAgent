# leocodebox 1.63.0 — iPhone 遥控:接管 LeoPhoneAgent 的 Mac 端

这一版让 leocodebox 直接说 LeoPhoneAgent 的 harness 协议。iPhone 上的 LeoPhoneAgent **零改动**即可把这台 Mac 当作编码 Agent 宿主:开会话、看流式输出、答审批、随时叫停。PhoneAgent 的 Mac 端(leoagent Python 服务、LeoAgentDesktop)从此不再单独开发。

## 新增:leophone 模块(`server/modules/leophone/`)

**harness 协议面**(与 leoagent 0.2.0 逐端点同构,iOS 客户端按原样对接):

```
GET  /health                                   免鉴权,可达性探测
GET  /v1/capabilities                          本机可用的编码 CLI 申报
GET  /v1/grok/token                            向本机 grok CLI 借登录态
GET  /harness/sessions                         会话列表(含召回的历史会话)
POST /harness/sessions                         {harness, cwd, prompt?} → 202
GET  /harness/sessions/{id}/events?after=N     SSE,先回放再实时,断线续传不丢不重
POST /harness/sessions/{id}/send               追加指令(多回合驾驶)
POST /harness/sessions/{id}/approval           答复审批(once/always/deny)
POST /harness/sessions/{id}/stop               终止
```

同时挂载于 `/leophone/*` 前缀(tailscale serve / 反代直连)与根路径别名(中继透传)。

- **四种 CLI 方言完整移植**:Claude Code(stream-json + stdio 审批)、Codex(app-server JSON-RPC)、pi(RPC)、Grok(ACP)。逐帧对齐 Python 版翻译器,含排队输入补发、审批按方言回写、未知帧原样透传。
- **事件持久化**:NDJSON + 单调 seq,先写日志后扇出;`?after=N` 回放与实时字节一致。沿用 `~/.leoagent/harness-sessions/`——**leoagent 时代的历史会话自动召回**(只读 orphaned,记录精确回放)。
- **中继客户端**:出站 WS 注册到自营 relay(读 `~/.leoagent/relay.json`,机器名自动一致),8 种帧类型对偶实现,25s 心跳,指数退避重连。
- **自动灰度**:检测到本机 leoagent(:8646)仍在服役时进入待命,不与它抢注中继;leoagent 一停,60 秒内自动接管。`LEOPHONE_RELAY_TAKEOVER=1` 立即接管,`LEOPHONE_RELAY=0` 停用。
- **鉴权隔离**:harness 面用 `~/.leoagent/key` 的 Bearer 方案(≥16 字符,常数时间比对),与本机 UI token 互不相通;手机的钥匙进不了 `/api/*`,UI token 也开不了 harness。

## 手机会话白捡 Leoapi

手机发起的 claude/codex 会话经过与桌面会话同一条 `applyActiveSwitchEnv` 注入路径:激活节点、路由槽、健康监测与故障转移**对手机同样生效**。

## 验证(本机实测)

- 新增 12 项单测(方言翻译 × 4、日志回放/续传、审批 id 铸造、召回、中继帧往返);服务端套件 349 项全过,typecheck/lint 全绿。
- 实机烟测(LeoyuandeMacBook-Pro-2):协议创建 codex 会话 → 排队输入在 threadId 就绪后补发 → `message.delta: "PONG"` → `run.completed`;第二回合 steer → `"PING"`;`?after=N` 续传、stop、会话列表(含召回的 leoagent 历史会话)全部正确。
- claude 方言在本机报 OAuth 过期——对照实验(干净环境直接跑 `claude -p`)确认是本机 claude CLI 登录态过期,与模块无关,Python 版 leoagent 同样受影响。

## 升级路径

1. 各 Mac 更新到 1.63.0(热更新)。
2. 想切到 leocodebox 承载手机会话的机器:停掉 leoagent(`launchctl bootout gui/$UID/com.leoyuan.leoagent`),本模块 60 秒内自动接管同名注册;回滚 = 重新拉起 leoagent。
3. relay.py(cortex :8650)与 iPhone 端零改动。
