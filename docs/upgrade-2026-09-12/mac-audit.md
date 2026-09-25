# macOS 专项源码审计与下一版本输入 · 2026-09-12

## 基线、范围与证据等级

- 主机 `LeoyuandeMacBook-Pro-2.local`。审计项目根 `/Users/leoyuan/Documents/日常 2/LeoPhoneAgent`；用户任务产物根 `/Users/leoyuan/Documents/ChatGPT/LeophoneAgent/outputs/upgrade-2026-09-12`。二者分开，未引用其他项目记忆。
- 主代理确认已 fetch：`main / origin/main = 094d4f8c97656366ec3a7858f9b0bd1b368ab7d2`，Mac 源码 `1.84.0`。本机安装 App 是 `1.74.2`，不可拿其截图证明本次源码效果。
- 读取根 AGENTS、README、9 月 6 日三轮审计。保留未跟踪 `docs/AUDIT_THREE_ROUNDS_2026-09-06 2.md`；没有编辑、提交或发布产品源码。
- 本专项采用 code-review-and-quality 的正确性/结构/安全/性能维度及 taste 中适用于产品 UI 的层级、可访问性检查。它是主任务多轮审计中的 Mac 专项输入，以下五个镜头并不冒充五遍完整独立安全扫描。
- **确定源码事实**：触发链可从代码确认；**局部复现**：隔离内存对象运行验证；**待测风险**：需要实际 Electron、新构建或设备验证；没有把静态判断写成实测性能/事故。
- 以下短路径均相对于 `src/mac/leocodebox/`，标有 `../leoagent` 者为同项目 Python 服务。

## 已有成果，升级时必须保留

9 月 6 日报告涉及的历史超时、有界刷新、转录缺失区分、重放截断标志、WS 空闲心跳/唤醒探活、旧子代理 jsonl 路径迁移、新任务入口、较早会话组都有对应实现，不能再次作为“本次新发现”。例如 `useSessionStore.ts:131-137,667-695` 有超时及有界刷新；`WebSocketContext.tsx:46-49,99-121,148-163` 有心跳；`chat-run-registry.service.ts:367-373` 有截断判断。已有 React 消息对象缓存、流缓冲隔离、Vite 分包、virtua、Reduce Motion、窗口权限边界、Electron sandbox/contextIsolation、Keychain safeStorage 等同样应继续利用。

## 镜头一：会话、任务与断线恢复

### M01 · P1 · 回放游标缺少 run 身份，第二轮可静默漏补流事件

**确定源码事实；尚未做真实模型网络断线实验。** `server/modules/websocket/services/chat-run-registry.service.ts:249-255` 每个新 run 把 `lastSeq` 重置为 0；客户端 `src/components/chat/hooks/useChatRealtimeHandlers.ts:104-109` 只接受更大的 seq，`ChatInterface.tsx:55-58` 以 session 为 Map key，全部引用中未见清零/按 run 分组。`replayEvents:351-357` 只返回 `seq > afterSeq`；`isReplayTruncated:367-373` 在服务器当前 seq 小于客户端旧水位时直接 false。

触发例：同一 session 第一轮到 seq=1000，第二轮到 seq=30 时断线；重订阅发送 after=1000，第二轮所有补放被过滤，且不触发 replayTruncated。重连前 REST 刷新（`ChatInterface.tsx:245-255`）能恢复已经持久化的内容，所以不是“整个对话必丢”；尚未写入转录的流内容与运行中状态事件仍存在缺口。

**升级**：事件必须带 `runId/epoch`，cursor 为 `{runId,seq}`，服务端 ack 返回当前 run 身份；换轮明确重置。不要仅在“用户点击发送”时清零，因为另一设备、队列或服务重启也会开新 run。

**验收**：第一轮 1000 帧、第二轮 50 帧，断网/切会话/另一客户端发起/排队启动各一次，恢复后当前流和审批无缺无重；包含服务重启 epoch 变化。可用 fake provider，避免模型成本和副作用。

### M02 · P1 · 排队任务保存的是旧 WebSocket 闭包，重连后新 run 可能仍向已关闭连接写

**确定源码链，待集成复现。** `chat-websocket.service.ts:180-187` 把 `()=>handleChatSend(ws,userId,data,dependencies)` 放进队列。客户端在任务排队期间重连时，只能给当时的 run 重新挂 socket（同文件 313-316）；队列后续 drain 又使用旧闭包内的 ws 创建新 writer。`chat-session-writer.service.ts:140-143` 检查旧 socket 非 OPEN 后直接丢实时发送。

附带缺口：`chat-run-registry.service.ts:279-301` 队列仅内存且无上限、任务 ID、到期/持久化/重启恢复；`useChatRealtimeHandlers.ts:173-178` 丢弃 `chat_queued` 和 `chat_queue_cleared`，全前端检索没有另一个消费位置。用户看不到准确队列位置与可撤回项。

**升级**：队列存命令数据，不存连接和可执行闭包；每条有 clientRequestId、queueItemId、queuedAt、状态和附件引用，运行时从当前订阅者集合取连接。定义重启为“待恢复、需重新确认”或“经授权自动恢复”，不要暗中重跑。设每会话/全局上限及可见拒绝。

**验收**：四并发占满→第五条排队→关闭旧连接→建立新连接→前任务完成，新的排队任务可见且只执行一次；服务崩溃后不存在幽灵队列；取消返回收据并更新 UI。

### M03 · P2 · 同一会话只能挂一个 writer，多个本地窗口/浏览器争抢实时流

**确定当前结构，不视作越权漏洞。** `chat-run-registry.service.ts:335-342` attachConnection 覆盖 writer socket；`chat-session-writer.service.ts:118-120,140-143` 只有单 `ws`。A、B 同时看同一任务，B 订阅会让 A 不再收到后续流，但 A 的连接心跳仍正常。

**升级**：run 与 transport 解耦，按会话保存订阅集合，区分观察者和审批控制者；输出广播，审批以 requestId 原子消费并广播已处理状态。这里复用已有 registry，不新增第三套任务总线。

**验收**：App 窗口+浏览器两观察者+手机可同时读；断开一方不影响其他；同一审批两端同时答，仅一次生效，第二方收到 already_resolved。

### M04 · P2 · 舰队网络失败后“在线”信息永久保留

**确定源码事实。** `src/components/workbench/useFleetSnapshot.ts:77-97` fetch 失败后保留上一快照，却没有 lastSuccessAt、stale/unknown 或连续失败次数；onlineCount 仍按旧 `online && reachable` 计算。9/6 已修“不同组件在线口径不一”，本项是新发现的时效维度。

**升级**：显示最近更新、重连中/状态过期；短暂失败保持列表避免闪烁，但超过阈值不再算“确认在线”。旧快照仍可查看，不允许旧 reachability 被当成新授权事实。

**验收**：成功获取后断开中继超过两轮；保留机器名称并变为“状态待确认”，在线数/可接管性一致；恢复时自动清除旧错误。

## 镜头二：原生系统能力与真实执行

### M05 · P1 · exact-window 的 observe/act 目前只更新内存，API 却可返回操作成功

**确定源码事实 + 已隔离运行复现，无系统动作。**

- `server/modules/leocodebox/exact-window.routes.ts:43-60` 的 observe 不读取 macOS；act 直接把 store.act 的 ok 包成 `success:true`。
- `exact-window.ts:77-91` observe 复制旧 frontmost、bounds、title，用新 timestamp/snapshotId 再 capture；不是重新观测系统。
- `exact-window.ts:94-114` act 仅做旧快照 freshness 与后台 coord 检查，然后调用上述 observe，没有 AX、菜单或坐标动作。
- `exact-window-macos.ts:60-68` 初始 bounds 是字面值 `unknown`。
- `server/modules/leophone/leophone.routes.ts:45-67` 对所有环境声明 `exact_window:true`，没有区分 metadata/binding、real observation、action execution 或权限 readiness。

隔离复现日志 `mac-logs/exact-window-repro.log`：旧快照过期→observe 后被认定新鲜但 hash、unknown bounds 与 frontmost 均不变→coord 返回 ok；执行实际系统动作数为 0。不能据此声称已发生错点；当前根本没有真实执行。

**升级**：先把能力准确拆成 `window.list/bind/observe/act`，未实现动作返回 unsupported，不能以成功语义交付。然后接原生观察适配器，以 pid+窗口稳定身份/生成号+bounds+捕获时间+内容证据建立真实快照；动作前重读/校验，动作后回读并产出 executed/verified/failed 收据。用户选择目标或显式确认绑定，不能用“此刻恰好前台”推断任务目标。

**验收**：不同 App 切前台、窗口关闭重建、同名窗口、弹窗遮挡、Retina/外接屏缩放、睡眠唤醒、AX 权限拒绝/撤销；旧快照不能靠纯内存刷新绕过；未发生动作绝不显示“已完成”。

### M06 · P1 · 枚举窗口同步阻塞 Node；一次失败可冻结全部本地 API 最长约 4 秒

**确定同步执行路径，实际耗时待测。** `exact-window-macos.ts:32-42` 使用 execFileSync 调 osascript，timeout=4000，脚本遍历所有前台应用窗口；`leophone.routes.ts:80-90` 创建 harness session 后同步 bindFrontmost；`exact-window.routes.ts:8-17` 每次枚举也走该同步路径。即使后台 provider 异步运行，主 Node 事件循环仍无法在同步子进程返回前处理其他 WS/HTTP。

**升级**：把窗口观测放入异步 execFile 或窄原生 helper，提供取消、并发合并、短缓存、权限状态；创建任务不要等待非必要窗口 metadata。返回 permission_denied/timeout 而不是统一空数组。

**验收**：模拟观测 4 秒超时，同时发 health、文本流、审批，后者不被阻塞；后台观测失败任务仍创建并明确“未绑定窗口”。

### M07 · P2 · 原生能力层尚非统一可发现目录

**架构缺口。** 当前有浏览器控制、文件/git/终端、通知、语音输入、relay/harness、窗口 metadata、Treasury PDF JXA 等能力，但没有按 OS 可用性、授权、前后台、风险、可撤销性、所需交互、执行结果验证统一描述。`src/shared` 当前仅 treasury fixture 和 bashism rules/test vectors/validator，没有设备能力和动作收据契约。

Mac 下一版本建议建立与 iOS 对齐的能力目录，而不是再加一大块“万能 shell”：文件选择/书签与作用域、Finder/Quick Look、系统分享、剪贴板、通知、日历/提醒、联系人、相机/麦克风/屏幕采集、App 激活、窗口/AX/menu、Shortcuts、设备状态、网络诊断。逐项写 native/API、最低系统版本、权限、用户交互与降级。

`src/components/chat/hooks/useVoiceInput.ts:66-75` 已用 getUserMedia/MediaRecorder；项目 electron/scripts/package 搜索未见自定义 NSMicrophoneUsageDescription/NSCameraUsageDescription，**不能直接据此认定发布包缺失**，builder 可能注入。应检查下一版最终签名包 Info.plist，并在全新 TCC 环境验证首次授权、拒绝、撤销、输入设备变化。

Mac 硬件不支持的 iPhone 能力（如后置闪光灯手电筒）应路由到明确选定的已授权 iOS 设备，能力目录报告不可本机执行；不要因为 shell 可调用而宣称所有系统能力已开放。

## 镜头三：UI、动画、可访问性与性能

### M08 · P1/P2 · 远程日志满 400 行后不再跟随，并每帧重挂近 400 行动画

**确定 React 状态/key 语义；未量测 FPS。** `RemoteSessionPanel.tsx:85` 保留末 400 条；滚动 effect `114-116` 只依赖 lines.length，长度达到 400 后新内容不再触发自动跟随。渲染 `199-202` key 为 seq-index，头部截断使所有保留行 index 移位，key 全变，每条新日志使近 400 行 remount。每行有 `wb-anim-entry`；`workbench.css:166` 是 300ms 入场动画。会造成可预期重绘/闪动成本，具体卡顿程度需仪器确认。

**升级**：稳定 eventId/seq key（兼容无 seq 的本地行）；复用已有 virtua 或按需有界窗口；只对真正新插入的少量语义消息动画，历史回放无入场；基于 lastEventId 跟随，但只有用户接近底部时跟随，上滚出现“新消息 N 条”。流 token 不逐字开动画；每帧/小窗口批处理 UI 更新。

**验收**：1000 行回放+持续输出，400→401时继续跟随；手动上滚不被拉回；保留行 DOM 身份不变；Reduce Motion 无位移动画；记录 60Hz/120Hz 的帧时长和输入延迟，不能拿颜色变化冒充流畅度提升。

### M09 · P2 · 项目抽屉声明 modal 但没有焦点约束/恢复

**确定局部源码缺口，最终键盘行为由主代理 CUA 验证。** `ProjectDrawer.tsx:27-32` 只有 Escape listener；`37-60` portal+普通 div role=dialog aria-modal=true，没有初始焦点、focus trap、inert 或关闭后焦点恢复。弹层开启后 Tab 有机会进入遮罩下的工作台；键盘使用者难以确认当前作用域。

**升级**：复用项目已存在的 Dialog/focus primitive；统一 Escape、遮罩、初始焦点、循环、关闭恢复、嵌套层级，而不是每抽屉手写监听器。`RemotePopover` 是非模态 dialog，不应机械套 modal trap，需分别定义。

**验收**：全键盘打开→首个有效输入→Shift-Tab/Tab不穿透→Esc→返回原触发器；VoiceOver 标签和公告完整；有长内容仍能滚动。

### M10 · P2 · 远程重连成功后旧红色错误可能继续显示

**确定源码事实。** `RemoteSessionPanel.tsx:98-102` 失败 setError；重连成功 `76-78` 只 setConnected(true)，不清 error。直到切目标或手动发送/审批才清除。会出现“正在跟随”同时保留“事件流断开”。

**升级/验收**：将连接状态和可行动错误区分；成功恢复清除 transient error，保留历史故障在诊断区；一次断开恢复后只有一个准确状态。避免把批准按钮与红色残留混在一起增加错误决策压力。

### 动效设计建议（待实施，不是当前实测成绩）

- 沿用现有 motion tokens、Reduce Motion 与 native 字体层级，避免再引入独立动画库来做普通面板切换。
- 导航/抽屉/任务详情体现同一实体的位置连续；时间预算：按钮反馈约 80–120ms、popover约140–180ms、面板约180–240ms，均为待调设计目标而非 Apple 强制规范。
- 运行中用稳定状态/活动光点，审批是需要用户处理的状态而非一直闪烁；完成只在状态首次变更时短提示，历史回放不再次庆祝。
- 大量流式日志优先持续可读、选择文本稳定和滚动锚点；不要给每 token、每行重放动画。
- 最小窗口1024×720、大字体、浅/深色、高对比、Reduce Motion、键盘/VoiceOver各验证；截图与帧跟踪分开，截图只能证明某一帧。

## 镜头四：Electron 边界与能力授权

### M11 · P2 · 通知设置 IPC 是写操作，但未做发送源鉴别

**确定配置写入边界弱于其他 IPC；未构造跨页面攻击。** `electron/main.js:541-547` 明确不 gate update-desktop-notifications，直接 saveSettings；`preload.cjs:3-12,82-88` 把 notifications bridge 暴露给所有 http localhost/127.0.0.1 以及匹配云域的页面，不校验本地端口。相比 `main.js:493-500,562-579` 的信任校验，此写接口扩大了能改通知偏好的页面范围。损害范围主要是通知设置，不能夸成任意命令执行或 token 窃取。

**升级**：把该写操作限定到已验证本地 origin/第一方 shell；读取可继续返回脱敏状态；同源任意页面仍属于 XSS 边界，API/IPC校验都不能省。

**验收**：正确本地端口可写，另一个 loopback 端口/子 frame/导航离开后拒绝；通知点击 deep-link 和配置保存仍正常。

### 保留的正面证据与待测范围

- Electron view/window `sandbox:true, contextIsolation:true, nodeIntegration:false` 已开启；多数敏感 IPC 走 trusted sender，不能笼统说“Electron 不安全”。
- 本地 token 握手校验 origin，更新凭据使用 safeStorage，已有桌面测试37项通过。
- 权限允许列表 `desktopWindow.js:634-651` 有 clipboard/media/notifications 与 origin 门禁，仍应结合请求 frame、实际 permission details、用户触发和系统 TCC 做下一版实机验证。
- 系统能力升级必须保持请求来源、当前目标、作用域、授权范围、过期条件、幂等键与动作回读。远程指令不能复用“手机已解锁”推断 Mac 已获屏幕/联系人等权限。
- 当前没有运行任何真实模型、发送外部消息、触发 AX、读取私人剪贴板或修改系统设置。

## 镜头五：日志、持久性、复用与结构

### M12 · P1/P2 · harness 每事件同步落盘，每次恢复同步读完整日志

**确定源码事实，规模影响待量测。** `server/modules/leophone/harness-session.service.ts:165-174` 每事件 exists/write/appendFileSync；`201-221` replay 无分页地 readFileSync 整文件、split并JSON.parse所有行，最后才按 afterSeq 过滤；`228-235` subscribe 先调用 replay。即使客户端只缺最后10帧也扫描全部历史。Python `../leoagent/harness.py:481` 也保有全量 replay 模式，不能只修TS忘记备用服务。

另一个真实性问题：日志写失败 catch忽略，但 `176-178` 注释和下游假定外推帧已经持久化；实际遇到磁盘满/权限错误时可有 live+push 成功而回放不存在。降级继续流是合理的，静默把它当 durable 不合理。

**升级**：使用顺序异步 writer；事件有 committed/durability 状态或在批量持久化后外推关键事件；seq→byte稀疏索引、异步流式分页读取、明确回放终点及后续实时衔接。先做轻量索引+边界，不必引入通用消息中间件。为文件损坏、磁盘满、进程退出设计可见降级和恢复。

**验收**：10MB/100MB/长任务日志读取最后100帧，Node health/审批仍响应；只读/磁盘满/半行损坏注入下有持久化警告与准确 receipt；重复订阅不漏不重；记录耗时/峰值内存/事件循环阻塞，不虚构基线数值。

### M13 · P2 · TS/Python 能力漂移尚缺共享契约门禁

**确定差异，可能是产品有意降级，不能把差异一律判成bug。** TS `harness-specs.ts:72-82` 提供Cursor one-shot，Python `harness.py:88-131` 仅四个harness；TS `leophone.routes.ts:51-65` 有 digest/receipt/artifacts/exact_window，Python `server.py:81-87` 只四个基础 features。双方注释强调同构，真实能力已不等价。

**升级**：保持备用Python可独立运行，能力协商如实返回支持矩阵；共享事件/approval/receipt/capability JSON schema与fixtures，让Swift/TS/Python共用契约测试。不要为了“统一”强制把Python重写成TS，先消除重复协议判断与能力误报。

**验收**：相同 fixture 三端解码、未知字段向前兼容、不支持能力清楚降级、Cursor one-shot不能被UI显示成可长期steer。共享契约变更按兼容性门禁交付。

### 结构规模与 Ponytail 建议

对 HEAD 的 `src/server/electron` 代码与CSS统计：19个文件超过800行（与旧报告“12个”的口径/基线不同，不直接宣称增加7个就是恶化）。重点是：`server/shared/utils.ts`1373，session-conversations-search1364，fleet.routes1235，mobileTerminalSelection1068，treasury.db984，browser-use.service935，claude-runtime916，useChatSessionState902，cli-tools.routes883，ProviderSkills865，CollectionsMirror857，localServer840，provider-switch.routes833，useSessionStore828。

按变化频率和状态耦合拆：fleet的HTTP代理/聚合/审批与receipt边界；shared utils按拥有者迁移；chat的run游标/订阅状态形成单一实现；窗口adapter仅实现真实平台边界；日志读取与写入为一个明确服务。先有回归用例再删除重复分支，不按“grep无引用”删代码（9/6已出现过误删恢复教训）。没有为本次报告删除任何文件，也不建议为了达到行数阈值机械切文件。

## 推荐实施顺序与可评分门禁

| 批次 | 具体用户收益 | 工作项 | 通过才可记分的证据 |
|---|---|---|---|
| A · 契约与可靠性 | 多轮任务不断片、排队可见、不会假成功 | M01/M02/M05，runId游标、数据化队列、真实capability状态 | fake-provider跨轮断线、排队重连、无执行不成功三组回归；新包实机复核 |
| B · 流畅与稳定 | 大任务不卡、日志持续跟随、状态可信 | M06/M08/M10/M12，异步窗口与日志、稳定key/锚点、stale展示 | 长日志与多窗口压测，UI帧跟踪、输入延迟、内存，断网恢复录像 |
| C · 原生能力 | Mac/iOS协同可发现、权限可理解、动作可核验 | M07/M11/M13，能力注册表、权限与receipt、共享fixtures | 每项 capability 的支持/拒绝/撤销/前后台/设备路由矩阵 |
| D · 体验完成度 | 键盘/VoiceOver同样完成核心任务 | M03/M04/M09，观察者模型、stale语义、focus管理、motion | 1024×720与常用尺寸、明暗/大字体/Reduce Motion、全键盘和VoiceOver |

评分采用“证据覆盖/通过率”而非主观保证：可靠性30、系统能力与真实闭环25、UI交互/可访问性20、性能15、维护与交付10。此文没有实机基线完整数据，因此不出虚构的当前总分，也不承诺做计划即可95分。**建议目标**：所有P1闭环无失败；既有测试不退化；核心任务场景100%通过；规划能力目录中每项都有合法状态和验收记录；性能目标在相同设备、相同数据、相同场景下比较。

## 本次验证记录

所有命令运行于上述项目，未运行release、postinstall或npm pretest:server；避免以验证之名重新构建原生依赖。原始日志位于本报告同级 `mac-logs/`。

| 命令 | 结果 |
|---|---|
| `node --test electron/*.test.js` | 退出0，37/37通过，无跳过 |
| `python3 -m unittest leoagent.test_relay_security`（cwd src/mac） | 退出0，13/13通过 |
| `node --experimental-transform-types --input-type=module`，直接导入exact-window.ts隔离对象 | 退出0，复现M05，无系统动作 |
| `npm run typecheck`（原目录） | 约6分钟仍未完成，主动终止本任务进程，退出143；不是通过也不是类型失败 |
| `node scripts/test-client.mjs`（原目录） | 退出0，162/162通过，无跳过，耗时283.8秒（包含依赖读取等待） |
| `node scripts/test-server.mjs`（原目录） | 部分测试开始输出，约6分钟仍未完成，主动终止，退出143；没有本次完整服务端通过结论 |

依赖存在但发现 `node_modules/tsx/dist/cli.mjs` 等具有macOS `compressed,dataless` 标志，初始测试和扫描长时间等待读取，之后部分client/server测试开始输出。此为本机验证环境限制，不直接归因产品性能。

主代理另做真实组件+模拟空数据预览：建议仅Vite，禁用所有proxy，拒绝非GET与WS，注入本地桌面空用户认证fixture；不启动会扫描真实HOME/会话/relay的后端。此种预览能证明最新源码组件布局和交互，不能证明原生授权、真实模型与最终签名App工作。


### 关键源码定位

- [每轮 seq 清零](</Users/leoyuan/Documents/日常 2/LeoPhoneAgent/src/mac/leocodebox/server/modules/websocket/services/chat-run-registry.service.ts:249>)
- [客户端只增加游标](</Users/leoyuan/Documents/日常 2/LeoPhoneAgent/src/mac/leocodebox/src/components/chat/hooks/useChatRealtimeHandlers.ts:104>)
- [队列捕获旧连接](</Users/leoyuan/Documents/日常 2/LeoPhoneAgent/src/mac/leocodebox/server/modules/websocket/services/chat-websocket.service.ts:180>)
- [窗口动作只有内存更新](</Users/leoyuan/Documents/日常 2/LeoPhoneAgent/src/mac/leocodebox/server/modules/leocodebox/exact-window.ts:94>)
- [同步窗口枚举](</Users/leoyuan/Documents/日常 2/LeoPhoneAgent/src/mac/leocodebox/server/modules/leocodebox/exact-window-macos.ts:32>)
- [400行日志边界](</Users/leoyuan/Documents/日常 2/LeoPhoneAgent/src/mac/leocodebox/src/components/workbench/RemoteSessionPanel.tsx:85>)
- [通知设置IPC](</Users/leoyuan/Documents/日常 2/LeoPhoneAgent/src/mac/leocodebox/electron/main.js:541>)
- [同步日志与静默降级](</Users/leoyuan/Documents/日常 2/LeoPhoneAgent/src/mac/leocodebox/server/modules/leophone/harness-session.service.ts:165>)

## 有界环境恢复与新增依赖证据

原目录iCloud占位导致检查停滞后，按主代理授权在首次确认不存在的 `/tmp/leophone-upgrade-audit-20260912` 以 `git archive 094d4f8c src/mac/leocodebox` 导出完全相同源码。只用该目录恢复依赖，`npm ci --ignore-scripts --prefer-offline --registry=https://registry.npmjs.org` 限时240秒，37.538秒退出0；没有改真实项目lockfile，没有执行安装生命周期脚本。本任务预览结束后清除临时源码和依赖，保留SHA和日志，不留下第二主仓。

- 隔离 `npm run typecheck`：7.449秒，退出0（客户端+服务端）。
- 隔离 `npm run build:client`：5.730秒，退出0，Vite构建成功。此为前端生产bundle，**不是Electron签名包构建**。
- 这两项通过证明原目录等待不能解释为产品类型/构建失败。原目录client162项通过依然有效，不为新环境重复同一套已过测试。
- 服务端补验在同一临时源码/依赖运行，复用原安装同lockfile的Electron执行文件、better-sqlite3和node-pty原生二进制；不是从零验证原生编译/打包。结果另记。

### M14 · 发布门禁/P1优先评估 · 新增依赖通告，不可沿用9月6日“生产依赖0漏洞”

本次以官方npm registry执行 `npm audit --omit=dev --registry=https://registry.npmjs.org --json` 退出1，JSON为 `mac-logs/isolated-audit-production-official.json`。返回 **8个受影响包节点，4 high、4 moderate**；这是传递依赖传播后的包节点数，**不是8个独立可利用项目漏洞**。安装时摘要和默认registry查询的聚合计数不同，因此报告以显式官方registry完整JSON为准。

根包及锁定实际版本：hono 4.13.1、multer 2.2.0、js-yaml 3.15.1 与 electron-updater 内的4.3.1。受传播影响节点还含 @anthropic-ai/claude-agent-sdk、@hono/node-server、@modelcontextprotocol/sdk、electron-updater、gray-matter。

- Multer通告含 crafted multipart字段名/大数组索引DoS、2.2.0中断上传FD泄漏、异步fileFilter race等。项目确有直接multipart入口 `server/modules/files/file-upload.routes.ts:17-32,69`、`server/modules/leophone/treasury.routes.ts:30`、`server/modules/assets/assets.routes.ts:31-43`；入口通常在本地鉴权后，不能虚称公网匿名RCE。assets的fileFilter是同步回调，不能把“异步filter竞态”不加区分地判为此处可利用。
- js-yaml通告为empty merge sources造成CPU耗尽；生产接入包括gray-matter解析与更新元数据。应追踪实际不可信YAML入口、大小上限和同步解析阻塞，不能把安装关联直接当成已验证利用。
- Hono通告含toSSG路径越界、parseBody嵌套耗尽、fragment后query解释差异；项目主要通过SDK间接引入，实际sink可达性待专门复核，不应因通告名称就声称本项目使用了toSSG。

建议升级候选最低修复线由通告range推导：multer>=2.3.0、hono>=4.13.5、js-yaml3.15.2/4.3.2；实施时再次核对上游版本与兼容性，逐组升级override和锁文件，并测上传中断/恶意字段名/技能frontmatter/更新元数据。没有执行 `npm audit fix`。发版门禁要求官方生产audit通过，或对每个未升级通告有可审核的不可达证据与明确责任人，不能只复用旧截图。

通告原链接（来自本次npm JSON）：[Multer字段名DoS](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm)、[中断上传FD泄漏](https://github.com/advisories/GHSA-qfvm-cv95-jqjf)、[js-yaml CPU耗尽](https://github.com/advisories/GHSA-2883-xcg3-v3hh)、[Hono parseBody](https://github.com/advisories/GHSA-g6gw-c38x-mqfc)。本专项没有进一步浏览通告原网页；技术结论限制在JSON与本地源码，主研究负责外部原始资料复核。

### 服务端补验最终结果

隔离全套75个测试文件、410个测试：首次 **409通过、1失败、0跳过，退出1，20.567秒**。唯一失败是 `shared cross-platform treasury fixture matches the Mac contract` 的ENOENT：初始临时archive范围只含src/mac/leocodebox，遗漏它引用的src/shared fixture。此为本次临时验证导出范围遗漏，**不是产品回归**。

从同一 `094d4f8c` 补导 `src/shared` 后，仅定向复跑受影响的 `server/modules/database/tests/treasury.db.integration.test.ts`：**9/9通过、退出0、1.520秒**。其他409项已经通过，不重复完整套件。日志 `isolated-server.log` 与 `isolated-server-treasury-recheck.log` 同时保留，不覆盖第一次失败证据。

综合本次可报告：desktop37/37、client162/162、Python relay13/13；Mac client+server typecheck通过；前端生产build通过；服务端全套409项通过+缺失共享fixture恢复后相关9/9通过。未验证新DMG签名/公证、干净设备安装、macOS原生权限或真实provider操作。原项目git status仍只有任务开始前同一个未知审计文档，无源码修改。


### 临时副本清理及键盘实测补证

主代理完成本次预览并终止预览服务后，已确认临时目录解析为 `/private/tmp/leophone-upgrade-audit-20260912`，仅含本任务 source.tar、shared.tar 和 src。已删除该临时源码、构建输出及依赖并验证路径不存在；报告、日志、截图全部保留于任务 outputs。清理记录：`mac-logs/temporary-cleanup.json`。没有留下第二主仓。

M09 已由主代理 CUA 操作实测补证：点击项目抽屉后焦点仍在外部触发器，Tab 可跳到遮罩背后的“任务目标”。证据见主任务 `evidence/mac-drawer-focus.txt` 及对应02截图；此项从局部源码风险提升为键盘行为已复现。其他视觉发现由主代理独立UI报告记录。
