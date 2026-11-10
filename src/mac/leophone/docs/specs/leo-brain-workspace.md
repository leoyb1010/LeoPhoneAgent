# 第二大脑工作区：后台与公共契约

状态：本包实现后台和公共契约，界面放到下一包。范围是 Mac 桌面端只读浏览第二大脑：状态、卡片目录、搜索、阅读卡片和资料。
不做上传、问答（`/v1/ask`）、自动把正文附给云端模型，也不调用任何模型。

## Owner 与数据流

```
UI（下一包）
  └─ usePlatform().leoBrain.query(request)            公共 port，类型在 @zcode/shared platform.ts
       └─ desktopPlatform.ts                           渲染进程里唯一读取原生桥（window.leoLink.brainWorkspace）的地方
            └─ preload leoBridge.ts                    ipcRenderer.invoke("leo:brain:workspace", request)
                 └─ main leoLinkIpc.ts                 isTrustedLeoSender + ownHostListening → callLeo（主钥匙 + x-leo-pair）
                      └─ Host httpApi.ts               POST /api/leo/brain/workspace：主钥匙门之后，再校验 x-leo-pair
                           └─ host/leo/brainWorkspace.ts   业务 owner：运行时校验请求、调网关、按字段投影结果、错误分类
                                └─ openBrainGateway()       每次请求都重新读本机 key 和 LEO_BRAIN_URL；key 只进 Authorization 头
```

- 业务 owner 是 `packages/desktop/src/host/leo/brainWorkspace.ts`，只做只读适配，不写盘、不缓存、不记录正文。
- 每次请求都重新调用 `openBrainGateway()`：用户替换失效的 key 后重试，马上生效。不使用 `readBrainStatus` 的 5 分钟缓存；首页卡片原有的缓存策略不变。
- 访问门：
  - 路由位于 Host 主钥匙校验之后。藏宝阁钥匙只能访问 MCP 和藏宝阁路由，访问不到这里。
  - 另外要求主进程内存口令 `x-leo-pair`。光有本机持久主钥匙读不到正文。
  - 路由不在手机 Link 白名单（`isLinkPath`）里。
  - 不接受任意网关路径或 URL 参数；网关路径由固定的 op 决定。
- 主进程只接受应用窗口自己的顶层页面（`isTrustedLeoSender`），并确认端口上是我们自己的 Host（`ownHostListening`）后才带口令转发。

## 请求（固定 op 判别联合，Host 端在运行时校验，不信任 TS 类型）

| op | 字段 | 校验 | 网关 |
| --- | --- | --- | --- |
| `status` | — | — | `GET /v1/health` |
| `cards` | `offset?` | 整数，0..100000，缺省 0 | `GET /v1/cards?offset&limit=50` |
| `search` | `query`、`scope?`、`offset?` | query 去掉首尾空白后 1..200 字符；scope 只能是 `all` / `files` / `cards`，缺省 `all`；offset 同上 | `GET /v1/search?q&scope&limit=20&offset&include_private=0` |
| `read` + `kind:"card"` | `id`、`offset?` | id 1..200 字符，不能含控制字符或 `/ \ ? # %`，不能是 `.` 或 `..`；offset 是正文的字符偏移 | `GET /v1/cards/<encodeURIComponent(id)>` |
| `read` + `kind:"file"` | `id`、`offset?` | id 同上；offset 是片段偏移 | `GET /v1/files/<id>`，再 `GET /v1/files/<id>/chunks?offset&limit=12` |

请求体上限 4 KiB。未知的 op、kind、字段类型都返回 `invalid_request`。搜索固定 `include_private=0`，不会自动请求私密资料。

## 结果

`{ ok: true, data }` 或 `{ ok: false, error: { code, message } }`。`data.op` 和请求的 op 一致；read 的结果带 `kind`。

- `status`：`{ op, cards: number | null, files: number | null }`。
- `cards`：`{ op, items: [{ id, title, category?, status?, version?, updatedAt?, summary? }], total, offset, nextOffset }`。
  `nextOffset = offset + items.length`，前提是它小于 total 且 items 非空；否则为 null。网关不会过滤卡片列表，所以可以用这个算法。
- `search`：`{ op, scope, query, items: [{ type: "file" | "card", id, title, path?, source?, ext?, category?, project?, privacy?, status?, score?, size?, mtime?, match?: { locator?, excerpt? } }], total, mode?, semanticUsed?, hiddenSensitive, offset, nextOffset }`。
  `nextOffset` 直接取网关的 `next_offset`。网关没给，或者给的值不大于当前 offset（防止死循环），就是 null。不用可见 items 的数量去推算，因为过滤掉的敏感条目会让这种推算出错。`hiddenSensitive` 原样保留。
- `read` card：`{ op, kind: "card", id, title, category?, status?, version?, createdAt?, updatedAt?, body, bodyOffset, bodyLength, nextOffset, sources: [{ fileId, locator? }] }`。
  正文每页最多 20000 个字符，不切开代理对。`nextOffset` 为 null 表示正文已经读完。不返回 history。
- `read` file：`{ op, kind: "file", id, title, path?, source?, ext?, size?, mtime?, category?, project?, privacy?, status?, summary?, chunkTotal, originalAvailable, backupAvailable, chunks: [{ id, locator?, text, method?}], chunkOffset, nextOffset }`。
  每次最多 12 片。`nextOffset` 按网关给的 total 计算，返回 0 片时为 null，避免死循环。UI 必须按 nextOffset 接着读，不能把一页当成全文。

只投影上面列出的字段，不回传原始 JSON、sha256、history 或任何凭据。可选字段类型不对就丢掉；必填字段缺失或类型不对就整个返回 `invalid_response`。网关如实返回空 items 时，结果是空列表，不是错误。

## 错误码

| code | 来源 |
| --- | --- |
| `not_configured` | 本机没有 key 文件，或者文件为空 |
| `unauthorized` | 网关 401（key 失效） |
| `forbidden` | 网关 403；主进程拒绝了不可信的调用方 |
| `not_found` | 网关 404（卡片或资料不存在） |
| `unreachable` | 网络错误、超时，网关返回 5xx 或其他非 2xx |
| `invalid_request` | 请求没通过 Host 的运行时校验 |
| `invalid_response` | 网关返回的不是 JSON，或者结构不符 |
| `host_unavailable` | 主进程连不上我们自己的 Host（端口被占、Host 没启动、Host 返回非 2xx） |

`message` 是简短的中文说明，不含 HTTP 原文、URL、key 或网关路径。UI 按 code 做本地化，不直接显示 message。错误不会被降级成空数据。

## 隐私

- key 只在 Host 进程里，只出现在发给网关的 Authorization 头里。渲染进程、主进程和返回值里都没有 key。
- 网关基址来自现有约定（`LEO_BRAIN_URL`，缺省是 `BRAIN_GATEWAY_URL`），不会传给界面。
- 正文不写盘、不进日志、不进任何 MCP 工具或画像同步，也不自动附给模型。
- 搜索不包括私密资料（`include_private=0`）。按 id 读取时，以网关自身的权限为准。

## 下一包 UI 的预期

- 只能通过 `usePlatform().leoBrain` 访问；port 不存在时（Web、手机远控）不显示入口。不能直接读 `window.zcode` 或 `window.leoLink`。首页 `LeoHomeBrainCard` 到时一起迁移过来。
- 搜索框加 scope 切换，分页按 `nextOffset` 加载，并提示 `hiddenSensitive` 条目已隐藏。
- 卡片目录分页；卡片阅读按 `nextOffset` 继续加载正文；资料阅读显示元信息加片段，按 `nextOffset` 加载更多。
- 错误页按 code 区分：没配置（引导去配置 key）、key 失效、没有权限、不存在、网络问题，每种都提供重试。

## 验收场景（由用户自测）

1. 本机没有 key：`status` 返回 `not_configured`。放进有效 key 后马上重试，返回卡片数和资料数。
2. key 失效：任意 op 都返回 `unauthorized`；换成有效 key 后重试成功。
3. 搜索一个已知关键词：结果有卡片也有资料，翻页按 `nextOffset` 进行；有敏感资料时 `hiddenSensitive` 大于 0。
4. 搜索空串、超过 200 字、scope 写错：返回 `invalid_request`。
5. 打开长卡片：分段读完正文，最后一段的 `nextOffset` 为 null。
6. 打开资料：能看到元信息和前 12 片，继续加载到最后。
7. 读取不存在的 id：返回 `not_found`；id 含 `/` 或 `..`：返回 `invalid_request`。
8. 断网：返回 `unreachable`。
9. 用本机主钥匙、不带 `x-leo-pair` 直接 POST 这个路由：返回 403；用藏宝阁钥匙：返回 401。

## 本批最小工作区 UI

- App 层拥有工作区打开状态，主侧栏与首页大脑卡片共用一个打开入口。已有业务会话、任务和工作区不被切换或重建。
- 工作区使用现有Dialog，提供卡片目录、按全部/资料/卡片范围搜索、点击阅读及分页。阅读只展示网关真实字段；空结果、未配置、401、403、失联、资料不存在分别显示。
- UI只经usePlatform().leoBrain，不直接读取原生全局桥；无自动上传、无问答模型调用、无自动把资料放入聊天上下文。
- 请求使用递增序号失效保护；关闭、切查询或切资料后，旧返回不能覆盖当前页面。不存在轮询、持久缓存或用户资料自动落盘。
- 连接恢复说明由用户展开高级步骤：在资料库授权当前Mac并配置现有独立key路径；UI不读取、展示、复制或接收令牌。重试重新读取当前Host配置。
- UI沿用现有黑白灰、正常前景色与中英文文案，使用共享Dialog/Button/Input；减少动态时不做位移。只做源码和必要生产编译，不运行UI或任何测试。
