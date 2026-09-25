# LeoPhoneAgent 下一版：真实上游、可参考代码与吸收策略

研究日期：2026-09-12（日期均按源站UTC记录；展示日不表示发布日期与提交日期相同）。项目根 `/Users/leoyuan/Documents/日常 2/LeoPhoneAgent`，基准 `094d4f8c97656366ec3a7858f9b0bd1b368ab7d2`。这是升级规划研究，不是实现或合并。通过本地源文件、`git fetch upstream --no-tags`、GitHub原始API、固定SHA源码和npm载荷检查取得证据；没有把stars或搜索摘要当质量保证。

## 一、结论与投入顺序

建议保留“原生iOS + Electron Mac + 一套LeoHarness”的现有路线，先让已经拥有的能力在失败、恢复、审批、多设备和低电量场景中兑现，再扩大系统工具与端侧智能。下一版最有回报的不是堆框架，而是六条：

1. **P0：保证操作可追踪、审批不串线、断线可恢复。** 现有seq、pendingApprovals、多设备事件已具备基础；补齐持久失败语义、terminal状态和统一协议适配。
2. **P0：离线承诺与实际执行一致。** 当前系统ASR的Offline在不支持本地识别时会静默切到服务端；改为明确失败/选择引擎。
3. **P1：按子系统吸收真实上游。** OpenMinis 1.13的iOS备份/内核与CloudCLI会话分支价值明确；与自有身份、网关、签名、CLI目录发现分批集成。
4. **P1：用任务状态驱动UI与动效。** 上下文恢复、审批卡、持续流式列表、拖拽与滚动仲裁、能耗自适应比更多循环特效更重要。
5. **P1：Mac公开API原生helper。** 让手机经受控网关调用Mac屏幕、窗口、文件及应用能力；权限、目标、结果回执都可见。iOS系统能力以主报告Apple官方矩阵为准。
6. **P2：按设备可用的离线ASR和小模型。** WhisperKit与whisper.cpp先二选一；MLX以摘要/分类/草稿小任务起步，不新增另一个Agent框架。

## 二、上游差距已核实到什么程度

### 2.1 OpenMinis：祖先关系与具体代码差额

`upstream`确为`https://github.com/OpenMinis/OpenMinis.git`。获取后为`4ef29002e88db1e20e462ec2ff46916e8a7dcb45`，最新release为1.13，2026-09-01。`git rev-list --left-right --count HEAD...upstream/main`为**417 / 26**；`git cherry HEAD upstream/main`有24个非merge补丁未找到相同patch-id。这证明双方已分叉，**不证明项目缺26项功能**，也不证明那些补丁没有被手工移植。

可直接排入拆分评估的iOS提交：

- `6c08b189c982a333a3559e18fea300427fa2a756`：备份/恢复、rclone目标与流式package writer。
- `421699de3703276ca042c96734f0cf6916829683`：Provider、语音、thinking与模型路由。
- `ada340b7a7147e31c599704c2248c25e152ec7d6`：聊天、同步、usage、intents和界面。
- `2df21b6a68bd037c9a9b8c4c0a2e32ffc6c5cc17`以及后续iSH子模块提交：kernel/terminal和依赖固定点。

逐文件确认本地没有`src/ios/Agent/Backup/BackupZipWriter.swift`和`BackupRestoreJournal.swift`；与上游差异分别为新增388行和195行。本地已有`SpeechRecognitionManager.swift`与`AIChatViewModel+SSEStream.swift`，不能整文件覆盖，尤其应保留fork语音修正与跨设备功能。OpenMinis release正文主要讲另一平台，iOS结论采用这里的iOS源码和提交，而不是将release所有条目误套iOS。

### 2.2 Mac：真实上游是CloudCLI UI，不能凭别名猜Cindy

本地`src/mac/leocodebox/NOTICE`和README一致指向`siteboon/claudecodeui`。未找到Cindy作为独立源仓的证据，不将该名称写成已证实上游。CloudCLI最新已发布版v1.37.3（2026-09-08），HEAD `5e73a49b...`。本地没有配置独立CloudCLI git remote，且代码被并入monorepo，因此**没有可可靠报告的Mac“落后N提交”**；采用文件/功能比较。

固定SHA代码已验证`codex-app-server.client.ts`使用`thread/fork`与`lastTurnId`；本地对应目录没有该client和fork provider，现有`codex-runtime.ts`仍以`@openai/codex-sdk`执行。先增加按已安装CLI能力启用的会话分支功能；上游chat/transcript性能与archive修复作为下一批回归对照，不能直接覆盖本地auth和desktop分支。

### 2.3 iSH与proot边界

本地iSH固定`8d53d6b9e47aa375d6a932ebb47f4ab6f71e66b1`；OpenMinis 1.13主仓固定`3f6384c70eefd1a370f121d3492a5f21f7767df9`；iSH当前默认分支为`094b03ec0f3ad14baf6aabaae25c26f533c24a44`。GitHub跨旧commit compare返回404后改用本机子模块fetch和提交图完成核验：本地固定点相对当前master为**本地独有1 / 上游独有43**，相对OpenMinis 1.13固定点为**1 / 25**。本地独有提交`8d53d6b9`是“support cancellable native offloads”，修改`kernel/native_offload.c`、`.h`、`kernel/task.h`共37增2删，属于必须保留的取消能力。不能直接把submodule指针切到master而丢掉它。当前master另含信号唤醒消费、ARM64浮点立即数一致性、缓冲耗尽不abort等修复；epoll/poll的两项修复又被后续revert，必须评估最终树，不按标题逐项cherry-pick。

proot的本地固定点与OpenMinis主仓一致，许可证清单说明它服务非iOS Linux sandbox；在本次iOS/Mac范围排除，不把“多一个沙箱”当功能升级。

## 三、16个保留项目的可执行取舍

“未归档”是当前API事实；最近提交日期只是活动证据，不代表质量/SLA。以下license核验到实际LICENSE文件；模型、图片和打包产物仍需逐件核验。详细metadata和全部已读源码固定链接在`sources.json`。

### 1. OpenMinis/OpenMinis

- 平台与选择：**iOS；受控上游迁移，P1**。
- 许可：GPL-3.0。当前未归档、未禁用。最近默认分支提交：2026-09-01T18:19:16Z；最新release：[1.13](https://github.com/OpenMinis/OpenMinis/releases/tag/1.13)，2026-09-01T18:25:00Z。
- 可吸收能力：优先抽取1.13的流式ZIP、恢复journal、目标确认与取消机制；内核相关升级单独一批。
- 与已有能力的差额：本地已有iCloud/同步和大量fork功能；精确核验BackupZipWriter.swift、BackupRestoreJournal.swift两文件缺失。不能把已有备份整体算作零分。
- 风险与限制：大批量备份包兼容、凭据导入边界、磁盘满恢复和iSH ABI联动；先构建同源版本再迁移真实备份副本。
- 固定源码：[src/ios/Agent/Backup/BackupZipWriter.swift](https://github.com/OpenMinis/OpenMinis/blob/4ef29002e88db1e20e462ec2ff46916e8a7dcb45/src/ios/Agent/Backup/BackupZipWriter.swift)；[src/ios/Agent/Backup/BackupRestoreJournal.swift](https://github.com/OpenMinis/OpenMinis/blob/4ef29002e88db1e20e462ec2ff46916e8a7dcb45/src/ios/Agent/Backup/BackupRestoreJournal.swift)。

### 2. siteboon/claudecodeui

- 平台与选择：**Mac；按功能选取补丁，P1**。
- 许可：AGPL-3.0 + Section 7附加条款。当前未归档、未禁用。最近默认分支提交：2026-09-08T10:55:28Z；最新release：[v1.37.3](https://github.com/siteboon/claudecodeui/releases/tag/v1.37.3)，2026-09-08T10:29:58Z。
- 可吸收能力：thread/fork及指定lastTurnId的会话分支；再对照v1.37.3的长会话性能、归档保留、编辑/继续会话边界。
- 与已有能力的差额：本地Mac已是该UI分支且保留本地账户、CLI模型发现等大量自有能力；本地codex-runtime.ts仍走SDK，未见上游codex-app-server.client.ts和codex-fork.provider.ts两文件。
- 风险与限制：不能按版本号1.84与1.37比较新旧；不整体替换desktop/auth/provider路径。保留CloudCLI attribution和修改声明。
- 固定源码：[server/modules/providers/list/codex/codex-app-server.client.ts](https://github.com/siteboon/claudecodeui/blob/5e73a49b89b4f13766fc2e22723297a36e7dcef2/server/modules/providers/list/codex/codex-app-server.client.ts)；[server/modules/providers/list/codex/codex-fork.provider.ts](https://github.com/siteboon/claudecodeui/blob/5e73a49b89b4f13766fc2e22723297a36e7dcef2/server/modules/providers/list/codex/codex-fork.provider.ts)。

### 3. OpenMinis/ish-arm64

- 平台与选择：**iOS；原生依赖升级候选，P1**。
- 许可：GPL-3.0 + LICENSE.IOS；部分贡献追加GPL-2.0许可。当前未归档、未禁用。最近默认分支提交：2026-09-01T18:10:44Z；最新release：[v2.0.0](https://github.com/OpenMinis/ish-arm64/releases/tag/v2.0.0)，2026-06-24T12:29:56Z。
- 可吸收能力：核对源码沿用jit命名的threaded-code解释器内存耗尽/恢复回归以及fork执行内核边界；修复必须伴随真机长时间命令运行与内存压力验证。
- 与已有能力的差额：现有子模块8d53d6b9；OpenMinis主仓1.13固定3f6384c7；iSH当前master为094b03ec。三个引用不能混为一个“最新版”。
- 风险与限制：GitHub compare旧提交返回404后已用本机子模块图核验：当前固定点相对master为1/43、相对OpenMinis 1.13固定点为1/25；本地唯一提交是必须保留的cancellable native offloads。LICENSE.IOS只是特定GPL/App Store条款冲突的不追究声明，不是Apple审核许可。
- 固定源码：[LICENSE.md](https://github.com/OpenMinis/ish-arm64/blob/094b03ec0f3ad14baf6aabaae25c26f533c24a44/LICENSE.md)；[LICENSE.IOS](https://github.com/OpenMinis/ish-arm64/blob/094b03ec0f3ad14baf6aabaae25c26f533c24a44/LICENSE.IOS)；[tests/regress/regress_jit_oom.c](https://github.com/OpenMinis/ish-arm64/blob/094b03ec0f3ad14baf6aabaae25c26f533c24a44/tests/regress/regress_jit_oom.c)。

### 4. openai/codex

- 平台与选择：**Mac宿主，iOS消费协议；官方协议优先，P0/P1**。
- 许可：Apache-2.0。当前未归档、未禁用。最近默认分支提交：2026-09-12T02:24:02Z；最新release：[rust-v0.154.0](https://github.com/openai/codex/releases/tag/rust-v0.154.0)，2026-09-09T22:35:38Z。
- 可吸收能力：app-server能力协商、thread/turn/item生命周期、结构化执行/文件审批和fork；按CLI版本生成/固定schema适配层。
- 与已有能力的差额：本地已有Codex SDK运行和LeoHarness；缺口是减少自行解析方言以及让不同入口共享同一审批、取消和恢复语义。
- 风险与限制：不要让手机直连无保护app-server；保留Mac网关鉴权。不能认为main schema全部适用于已安装CLI；采用release契约并做协议探针。
- 固定源码：[codex-rs/app-server/README.md](https://github.com/openai/codex/blob/53ff712a48379ce8df605e292afd6046ca88ae9b/codex-rs/app-server/README.md)；[codex-rs/app-server-protocol/schema/json/CommandExecutionRequestApprovalParams.json](https://github.com/openai/codex/blob/53ff712a48379ce8df605e292afd6046ca88ae9b/codex-rs/app-server-protocol/schema/json/CommandExecutionRequestApprovalParams.json)。

### 5. agentclientprotocol/agent-client-protocol

- 平台与选择：**Mac适配器，iOS规范映射；借鉴v1稳定契约，P1**。
- 许可：Apache-2.0。当前未归档、未禁用。最近默认分支提交：2026-09-11T18:36:29Z；最新release：[schema-v1.21.0](https://github.com/agentclientprotocol/agent-client-protocol/releases/tag/schema-v1.21.0)，2026-08-20T19:43:13Z。
- 可吸收能力：规范permission request/response、会话resume/取消、能力握手和错误分类；映射到项目已有事件词汇。
- 与已有能力的差额：本地已有pendingApprovals Map、approval_id与seq。提升点是统一明确契约、版本协商、未知事件兼容，而不是再加第二个客户端状态机。
- 风险与限制：本次读取v1 schema和已稳定resume公告；v2/RFD不能当稳定API。ACP是Agent-client边界，MCP是tool/resource边界，不混用。
- 固定源码：[docs/announcements/session-resume-stabilized.mdx](https://github.com/agentclientprotocol/agent-client-protocol/blob/f1293d8e43d09a6745ff8fe717f9acd8299591b7/docs/announcements/session-resume-stabilized.mdx)；[schema/v1/schema.json](https://github.com/agentclientprotocol/agent-client-protocol/blob/f1293d8e43d09a6745ff8fe717f9acd8299591b7/schema/v1/schema.json)。

### 6. modelcontextprotocol/swift-sdk

- 平台与选择：**iOS/Mac Swift桥；定向替换传输或参考测试，P2**。
- 许可：Apache-2.0迁移中；未同意重许可旧贡献保留MIT；非规范文档CC-BY-4.0。当前未归档、未禁用。最近默认分支提交：2026-04-29T11:34:21Z；最新release：[0.12.1](https://github.com/modelcontextprotocol/swift-sdk/releases/tag/0.12.1)，2026-05-07T08:37:25Z。
- 可吸收能力：HTTP/SSE session ID、Last-Event-ID恢复、retry与OAuth授权处理。先用现有传输兼容测试决定是否采用。
- 与已有能力的差额：项目已有MCP/offload与Python终端通道；收益是将真实Swift直连工具统一为可取消、可重连传输，不能同一服务维持三套客户端。
- 风险与限制：许可不能标成简单MIT；移动后台、凭据域绑定与SSE恢复不自动由库解决。0.12.1发布后没有近期commit不等于停止维护。
- 固定源码：[LICENSE](https://github.com/modelcontextprotocol/swift-sdk/blob/a0ae212ebf6eab5f754c3129608bc5557637e605/LICENSE)；[Sources/MCP/Base/Transports/HTTPClientTransport.swift](https://github.com/modelcontextprotocol/swift-sdk/blob/a0ae212ebf6eab5f754c3129608bc5557637e605/Sources/MCP/Base/Transports/HTTPClientTransport.swift)。

### 7. BytePioneer-AI/codex-host

- 平台与选择：**Mac；已有依赖分批升级，P0/P1**。
- 许可：仓库MIT；分发载荷含多种许可及Claude Agent SDK专有使用条款。当前未归档、未禁用。最近默认分支提交：2026-09-12T02:43:16Z；最新release：[v0.7.1](https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.7.1)，2026-09-12T02:58:03Z。
- 可吸收能力：参考结构化交互响应校验、thread到账户绑定；已有0.4.4先做与已安装Codex Desktop兼容性，再评估0.7.1修复。
- 与已有能力的差额：不是从零引入：package.json和lock已固定@codexhost/cli 0.4.4。0.7.1是9月12日发布的兼容修复，跨版本候选功能需逐项验证。
- 风险与限制：耦合Codex Desktop内部桥/渲染扩展；源仓MIT不能覆盖整包SDK。必须保留载荷notices、核验源tag→构建→npm摘要→签名App的链路。
- 固定源码：[scripts/release/prepare-npm-meta.mjs](https://github.com/BytePioneer-AI/codex-host/blob/e6adb05095aff8aba5241230b07619c8b8aa8db4/scripts/release/prepare-npm-meta.mjs)；[packages/harness-adapter/src/interaction.ts](https://github.com/BytePioneer-AI/codex-host/blob/e6adb05095aff8aba5241230b07619c8b8aa8db4/packages/harness-adapter/src/interaction.ts)；[packages/host-runtime/src/account/thread-account-store.ts](https://github.com/BytePioneer-AI/codex-host/blob/e6adb05095aff8aba5241230b07619c8b8aa8db4/packages/host-runtime/src/account/thread-account-store.ts)。

### 8. anomalyco/opencode

- 平台与选择：**Mac事件宿主，iOS订阅；借鉴持久事件不引入整套运行时，P0**。
- 许可：MIT。当前未归档、未禁用。最近默认分支提交：2026-09-11T13:16:41Z；最新release：[v1.18.30](https://github.com/anomalyco/opencode/releases/tag/v1.18.30)，2026-09-09T03:34:27Z。
- 可吸收能力：事件与投影事务提交、aggregate seq校验、owner隔离、replay分歧检测和bounded subscriber。
- 与已有能力的差额：本地已有NDJSON先写后广播以及512队列上限；实测静态路径显示写失败仍向live/push广播，需显式durability契约和恢复缺口。
- 风险与限制：OpenCode当前使用Effect及DB层；复制整个event.ts会引入重型架构。只把不变量落实到现有存储，先故障注入再决定SQLite journal。
- 固定源码：[packages/core/src/permission.ts](https://github.com/anomalyco/opencode/blob/95daf90670b7c039c436c85537da5fbfe2205b41/packages/core/src/permission.ts)；[packages/core/src/event.ts](https://github.com/anomalyco/opencode/blob/95daf90670b7c039c436c85537da5fbfe2205b41/packages/core/src/event.ts)。

### 9. farion1231/cc-switch

- 平台与选择：**Mac节点/Provider层；借鉴熔断与恢复测试，P1**。
- 许可：MIT。当前未归档、未禁用。最近默认分支提交：2026-09-11T15:23:51Z；最新release：[v3.20.3](https://github.com/farion1231/cc-switch/releases/tag/v3.20.3)，2026-09-11T16:10:52Z。
- 可吸收能力：closed/open/half-open熔断、退避、恢复探测和用量归因；API切换“最快”之外加入会话安全与失败归因。
- 与已有能力的差额：本地已参考CC Switch，有Leoapi测速和故障转移；差额是针对正在执行的工具/流式会话设置是否可重试/切换的明确边界。
- 风险与限制：不可盲目重试带副作用工具，不可在用户未感知时改变模型语义或计费账户；配置导入必须保留备份和真实来源。
- 固定源码：[src-tauri/src/proxy/circuit_breaker.rs](https://github.com/farion1231/cc-switch/blob/d695a2d77fd9081eafd3e9eedcbf2a97b3410928/src-tauri/src/proxy/circuit_breaker.rs)。

### 10. steipete/CodexBar

- 平台与选择：**Mac，策略可共享iOS；借鉴刷新策略，P1**。
- 许可：MIT。当前未归档、未禁用。最近默认分支提交：2026-09-12T03:30:33Z；最新release：[v0.59.0](https://github.com/steipete/CodexBar/releases/tag/v0.59.0)，2026-09-11T05:46:26Z。
- 可吸收能力：自适应刷新将窗口交互/编码活动/低电量/热压力归一到单一决策表；状态显示加入数据时间和来源。
- 与已有能力的差额：本地NOTICE说明已经参考quota布局且自主采集；下一版应减少无意义后台轮询，不再增加重复菜单栏应用。
- 风险与限制：不要复制对登录cookie/内部API的假设；不同provider配额含义不相同。数据不可得显示未知而不是0。
- 固定源码：[Sources/AdaptiveRefreshCore/AdaptiveRefreshPolicyCore.swift](https://github.com/steipete/CodexBar/blob/9bf04c73e5a3534b78190c5621312a8ea4310dfa/Sources/AdaptiveRefreshCore/AdaptiveRefreshPolicyCore.swift)。

### 11. argmaxinc/WhisperKit

- 平台与选择：**iOS/Mac；可选单一ASR依赖候选，P2**。
- 许可：MIT；模型资产许可另核。当前未归档、未禁用。最近默认分支提交：2026-08-13T19:17:27Z；最新release：[v1.1.0](https://github.com/argmaxinc/argmax-oss-swift/releases/tag/v1.1.0)，2026-08-06T17:54:25Z。
- 可吸收能力：actor隔离的音频流识别、confirmed/unconfirmed分段、语音能量门限、可停止的录音/推理；先做中文与中英混合实测。
- 与已有能力的差额：项目已有SystemVoiceProvider、RealTimeCutVAD和云语音；补充的是保证用户选离线后的可用替代，不应把现有能力描述为空白。
- 风险与限制：模型首下载/磁盘/内存/发热、蓝牙与电话打断、静音幻觉。WhisperKit与whisper.cpp先A/B只留一个正式引擎，默认系统语音。
- 固定源码：[Sources/WhisperKit/Core/Audio/AudioStreamTranscriber.swift](https://github.com/argmaxinc/WhisperKit/blob/ea872ffd35705aa757f33033500b9b0d40bd38df/Sources/WhisperKit/Core/Audio/AudioStreamTranscriber.swift)；[Package.swift](https://github.com/argmaxinc/WhisperKit/blob/ea872ffd35705aa757f33033500b9b0d40bd38df/Package.swift)。

### 12. ml-explore/mlx-swift-lm

- 平台与选择：**iOS/Mac Apple Silicon；可选离线小任务Provider，P2/实验**。
- 许可：MIT；每个模型权重独立许可。当前未归档、未禁用。最近默认分支提交：2026-09-11T03:52:23Z；最新release：[3.31.4](https://github.com/ml-explore/mlx-swift-lm/releases/tag/3.31.4)，2026-06-30T16:31:18Z。
- 可吸收能力：ModelContainer/ChatSession上下文管理、工具roundtrip、wired-memory admission/budget；先部署摘要、标题、分类、可撤销结构化草稿。
- 与已有能力的差额：现有Provider架构可复用，避免为端侧模型再起完整Agent；必须先建立设备/内存/热状态与模型可用性清单。
- 风险与限制：不要承诺所有iPhone可跑大模型或云级能力。推理前预算+缓存上限+热降级，权重下载可取消、摘要校验与退出释放。
- 固定源码：[Libraries/MLXLMCommon/ChatSession.swift](https://github.com/ml-explore/mlx-swift-lm/blob/604fae710a4e3324346fc59e3845952350acd4b7/Libraries/MLXLMCommon/ChatSession.swift)；[Libraries/MLXLMCommon/WiredMemoryPolicies.swift](https://github.com/ml-explore/mlx-swift-lm/blob/604fae710a4e3324346fc59e3845952350acd4b7/Libraries/MLXLMCommon/WiredMemoryPolicies.swift)。

### 13. ggml-org/whisper.cpp

- 平台与选择：**iOS/Mac；与WhisperKit的对照候选，不双引入**。
- 许可：MIT；模型资产许可另核。当前未归档、未禁用。最近默认分支提交：2026-09-11T14:13:24Z；最新release：[v1.9.4](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.4)，2026-09-11T05:31:55Z。
- 可吸收能力：参考低层流式/VAD实现和量化模型基准；仅当Core ML路线在指定设备/中文语料不达标才选C/C++桥。
- 与已有能力的差额：已有FFmpeg和本地音频流程，不等于必须再绑定一个底层音频栈；差额须以p95延迟、字错率和能耗证明。
- 风险与限制：示例stream不是完整生产语音产品；维护C++/Swift桥、模型格式、Metal构建与App包大小成本高。
- 固定源码：[examples/stream/README.md](https://github.com/ggml-org/whisper.cpp/blob/1da4dc82fa7996d4edda05890dca65aeceaafd6d/examples/stream/README.md)。

### 14. FluidGroup/swiftui-scrollview-interoperable-drag-gesture

- 平台与选择：**iOS/iPadOS；手势仲裁参考，P1**。
- 许可：Apache-2.0。当前未归档、未禁用。最近默认分支提交：2026-05-06T14:12:41Z；最新release：[0.5.0](https://github.com/FluidGroup/swiftui-scrollview-interoperable-drag-gesture/releases/tag/0.5.0)，2026-05-06T14:13:21Z。
- 可吸收能力：拖拽手势与ScrollView同时识别、边缘锁定与内层滚动判断，应用于聊天sheet、侧栏和下拉动作的冲突。
- 与已有能力的差额：项目已有自有SwiftUI动效；先定位“拖页面触发sheet/滚动中误触”实测问题，再做小范围手势仲裁。
- 风险与限制：依赖UIGestureRecognizerRepresentable的平台可用性；必须验证最低系统版本、横竖屏、VoiceOver、外接键盘。优先借鉴局部逻辑。
- 固定源码：[Sources/SwiftUIScrollViewInteroperableDragGesture/SwiftUIScrollViewInteroperableDragGesture.swift](https://github.com/FluidGroup/swiftui-scrollview-interoperable-drag-gesture/blob/ee6daeca239c6cb180724f1c4bfad383f58eac22/Sources/SwiftUIScrollViewInteroperableDragGesture/SwiftUIScrollViewInteroperableDragGesture.swift)。

### 15. airbnb/lottie-ios

- 平台与选择：**iOS；当前Electron Mac不直接适用；仅插画/状态动画候选，P2**。
- 许可：Apache-2.0；动画资产独立许可。当前未归档、未禁用。最近默认分支提交：2026-09-02T17:51:00Z；最新release：[4.6.1](https://github.com/airbnb/lottie-ios/releases/tag/4.6.1)，2026-06-13T16:30:00Z。
- 可吸收能力：学习reduce-motion marker、disabled motion与渲染引擎降级；审批成功、首次连接等短暂插画可按需引入。
- 与已有能力的差额：LeoMotionEffects已做transform/opacity和Reduce Motion；下一版先完善后台/离屏/低电量停止及状态中断，不需要用Lottie改写基础交互。
- 风险与限制：Core Animation不支持的效果会回退；列表内循环与大型JSON会损害流畅性。禁止为了炫技在每条消息启动时间线。
- 固定源码：[Sources/Public/Configuration/ReducedMotionOption.swift](https://github.com/airbnb/lottie-ios/blob/8384dfbc429a5b3748e51d2744cbaad9ecb7a6fe/Sources/Public/Configuration/ReducedMotionOption.swift)；[Sources/Public/Configuration/RenderingEngineOption.swift](https://github.com/airbnb/lottie-ios/blob/8384dfbc429a5b3748e51d2744cbaad9ecb7a6fe/Sources/Public/Configuration/RenderingEngineOption.swift)。

### 16. steipete/Peekaboo

- 平台与选择：**Mac；公开API原生桥参考，P1**。
- 许可：MIT。当前未归档、未禁用。最近默认分支提交：2026-09-12T03:40:45Z；最新release：[v4.3.4](https://github.com/openclaw/Peekaboo/releases/tag/v4.3.4)，2026-09-12T03:37:18Z。
- 可吸收能力：ScreenCaptureKit权限实际探测、错误归因、签名身份/owner lease、前后截图与操作结果验证，补全Mac系统能力入口。
- 与已有能力的差额：Mac已是手机能力宿主，有CLI/浏览器能力；应加小型有版本的Swift helper负责TCC与公开系统API，不整体迁成SwiftUI/Tauri。
- 风险与限制：源仓同时包含Legacy/PrivateScreenCaptureKit文件，本次明确只评估公开ScreenCaptureKit与Accessibility路径；不要复制私有调用或跳过TCC。远程动作需目标应用/窗口与单次授权。
- 固定源码：[Core/PeekabooAutomationKit/Sources/PeekabooAutomationKit/Services/Capture/ScreenCapturePermissionGate.swift](https://github.com/steipete/Peekaboo/blob/ba778dfe891f2051ffc13a2a4fff51cee1f068f4/Core/PeekabooAutomationKit/Sources/PeekabooAutomationKit/Services/Capture/ScreenCapturePermissionGate.swift)；[Apps/CLI/Sources/PeekabooCLI/Commands/Base/Runtime/BridgeCapabilityPolicy.swift](https://github.com/steipete/Peekaboo/blob/ba778dfe891f2051ffc13a2a4fff51cee1f068f4/Apps/CLI/Sources/PeekabooCLI/Commands/Base/Runtime/BridgeCapabilityPolicy.swift)。

## 四、CodexHost 0.4.4供应链核验

本地`package.json:151`固定`@codexhost/cli` 0.4.4；lock中meta和darwin-arm64包都有sha512。研究实际下载两个npm tgz到内存，未执行其中代码，重算sha512与lock/registry**全部相符**。因此可以证实当前锁文件与公开分发字节相配。

registry的repository都指向BytePioneer-AI/codex-host；已读SLSA payload把包绑定到`refs/tags/v0.4.4`、源码`dc23e9bd44a1d0be249edf9f4d705b44badb9bdb`以及`.github/workflows/release-packages.yml`。这是**已解码并交叉核对的provenance声明**，本次没有完成Sigstore/Rekor证书链密码学验证，不得写成“已证明供应链绝对可信”。

两个npm包的package.json都没有license字段；meta tgz只有3个文件，darwin-arm64为18个文件，包含renderer-extension.js、desktop-controller.mjs、host-runtime.mjs、shim、updater、THIRD_PARTY_NOTICES与依赖license目录。载荷中的`@anthropic-ai/claude-agent-sdk 0.3.220`使用专有使用条款；其他含MIT/BSD/ISC。所以**仓库MIT不能替整包SDK做分发许可结论**。当前tgz也未带CodexHost根LICENSE，集成应用需保存源仓MIT文本与准确notice。

v0.7.1（2026-09-12）release明确修复Codex Desktop 26.908.40834的外部Harness连接和Composer模型/权限设置。这支持“版本耦合需要兼容矩阵”的结论；不支持无条件升级立即上线。推荐构建矩阵：当前安装Desktop × 0.4.4/候选0.7.1 × Claude/Codex/OpenCode；覆盖启动、已有会话、审批、取消、恢复、应用退出、不写已签名App包和更新回滚。

源证据：[0.4.4发布](https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.4.4)、[当前0.7.1发布](https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.7.1)、[meta包metadata](https://registry.npmjs.org/@codexhost%2fcli/0.4.4)、[arm64包metadata](https://registry.npmjs.org/@codexhost%2fcli-darwin-arm64/0.4.4)。本地缓存保存逐文件license、metadata、provenance声明，未保留/执行二进制。

## 五、已有实现中的两个高价值修正

### 5.1 离线ASR不能静默联网

本地`src/ios/Providers/Voice/VoiceProvider+System.swift:125–126`令`useOnDevice = wantOnDevice && recognizer.supportsOnDeviceRecognition`，145行再赋`requiresOnDeviceRecognition = useOnDevice`；注释也写明Offline不支持时降到Online。因此这里是**明确静态语义证据**，不是只由UI截图推断。下一版应区分Offline/Auto/Online三种执行政策：Offline不支持→错误/模型下载/用户改选；Auto允许按已授权偏好回退；Online明确展示。

验收：系统不支持该locale、模型未就绪、飞行模式、超时、录音中电话/蓝牙切换、连续取消场景；Offline测试通过网络观测确认不发出云识别请求。ASR准确率/时延要使用相同中文与中英混合语料比较System/WhisperKit/whisper.cpp，不能凭项目宣传排名。

### 5.2 已写后广播的设计遇到写失败时破功

本地`src/mac/leocodebox/server/modules/leophone/harness-session.service.ts:165–190`中`appendFileSync`异常被catch忽略，随后仍向push和live订阅广播；若队列达到512则断开订阅，并依赖日志恢复。当前已有防串审批ID和有限队列是优点，但“显示完成/待批”与“可恢复”可能在磁盘满时分离。

建议：区分`durableSeq`和临时流进度，关键事件持久失败明确进入degraded状态，UI和iOS不得宣称可无损恢复；保留stdout抽取防止堵住CLI，避免简单throw杀掉泵；审批/终态需要明确提交结果、幂等键与恢复缺口。并发写/崩溃一致性若超出现有NDJSON能力，再迁移项目已有SQLite，不为此接入OpenCode全部Effect运行时。

验收：注入ENOSPC/EACCES、截断NDJSON、进程在写/广播间退出、重复approval响应、慢订阅者溢出、同seq不同payload、10分钟断线重连；期望是不静默丢关键事件、不重复执行、不把未落盘状态伪装成可恢复。

## 六、从开源参考到体验提升的落地包

| 工作包 | 用户可感知变化 | 复用位置 | 最小验收 |
|---|---|---|---|
| 会话连续性 | 切前后台/换网络后回到同一位置，待批卡准确，完成结果不丢 | LeoHarness + Codex/ACP契约 | 断线、kill、慢消费者、重复审批故障矩阵 |
| 更丝滑的聊天 | 长会话流式输出不中断滚动，用户读旧消息不被强拉到底 | 现有消息列表 + CloudCLI性能补丁、局部手势仲裁 | 固定长会话/代码块/图片语料；真实设备frame hitch、输入延迟、内存 |
| 动效一致性 | 运行→等待审批→完成有短而清晰的连续反馈 | LeoMotion token和现有modifier | Reduce Motion运行中切换、离屏停止、低电量、快速连续点击 |
| 安全可恢复备份 | 真进度、取消确实停止、失败可定位、恢复前能确认影响 | OpenMinis BackupZipWriter/RestoreJournal | 大包低内存、磁盘满、部分目标成功、中断恢复、凭据选择 |
| Mac系统执行 | “看此窗口→操作→确认结果”有目标和回执 | 小型Swift helper + 公共ScreenCaptureKit/AX + 网关 | TCC拒绝/撤销、窗口切换、权限归属、签名后运行 |
| 真离线语音 | 用户选离线就不会静默发云端；可看模型大小与设备支持 | SystemVoiceProvider + 单一可选ASR | 中英混合CER、TTFT、能耗、电话打断、网络无请求 |
| 端侧小任务 | 无网也能做标题/摘要/分类/草稿 | Provider接口 + 可选MLX | 设备准入、模型许可、下载中断、内存/热预算、回退透明 |
| 安静的后台 | 菜单栏/额度仍新鲜，空闲时CPU与唤醒减少 | CodexBar式单一刷新决策表 | idle/active/thermal/low-power录制对照 |

评分提升应由主报告的同一评分表和基准测量确认。本研究只提供可让评分上升的因果路径和验收项，不能把“计划完成后目标分”当成已经测得分数。

## 七、主动不采用与不确定项

- 不整体迁移Tauri、SwiftUI Mac或新Agent编排框架；当前两端已具备大量能力，重写将推迟真实缺陷修复。
- 不同时引入WhisperKit、whisper.cpp、多个动画框架；先基准后二选一或保持系统实现。
- 不把Peekaboo中的私有ScreenCaptureKit/历史兼容路径移入产品；只复用公开API思路与权限/回执测试。
- 不把MCP当iOS越权入口。iOS系统工具可调用性取决于公开API、entitlement、设备、前台/后台和用户权限；主报告必须把不可调的系统设置/其他App控制明示为限制。
- GitHub的默认分支会移动，因此所有代码引用固定SHA；最新release与master可能不同，正式引入应固定release或审核commit。
- 未执行任何候选库的完整构建或真实设备性能测试；维护状态只依据归档位、提交与release，不暗示代码质量已全面安全审计。
- 调研过程中一个SwiftUI动画仓库候选返回404，已排除；proot也因不属于本次平台能力排除。无证据不补猜。

### iSH术语补充

已读取iSH固定SHA README，它明确ARM64后端是在Asbestos threaded-code解释器中运行，使用预编译gadgets，而非运行时生成机器码的JIT。源码路径/测试仍有jit命名，因此本文JIT OOM指上游测试命名，不能把它宣传成突破iOS JIT限制。README关于速度倍率属于上游自述，本次未实测，不纳入性能承诺。
