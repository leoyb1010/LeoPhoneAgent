# iOS Paperclip 原生验证

在 macOS 的 Xcode 与本机白名单 iPhone 模拟器上运行（默认通过 `~/.config/apple-simulator-policy/simulators.py id iphone` 取 UDID；该策略不存在时必须用 `PAPERCLIP_TEST_DESTINATION="id=<UDID>"` 显式指定）：

```sh
brew install xcodegen
bash scripts/native-paperclip-audit/run.sh
```

此独立宿主直接编译 `src/ios/Agent/Paperclip` 与 `src/ios/Views/Paperclip` 中全部生产 Swift 文件，不加载 iSH、FFmpeg、Watch 或原 App。它运行：

- Foundation 契约、身份绑定、HTTPS 地址、状态中文、草稿恢复测试
- URLProtocol 生产客户端测试：人类会话、Cookie 范围、禁止 Bearer Key、超时不确定性、回执、跨组织数据拒绝
- 真实 WebKit 容器隔离与配置恢复测试
- 真实 SwiftUI 界面旅程：默认本机、切换服务器、中文空状态（未连接时没有搜索框）、HTTP 拒绝、取消与反复返回，并保存截图
- 使用 URLProtocol 固定服务响应驱动真实生产工作区页面：有数据的任务列表、创建回执与详情、回复回执、状态修改、关联审批确认与回执，并保存截图。此组是模拟 API 原生旅程，不是真实 Paperclip 部署联调

宿主的“本机会话保留”页面仅为导航占位，不能证明原 App 的本机能力运行。`IOSPaperclipContractAudit.py` 专门核对生产 `MinisApp` 仍通过 `IOSWorkspaceRootView { ContentView() }` 接入原根视图，且 Paperclip 客户端没有引用旧 Gateway/ChatStore 执行接口；真实本机全能力仍需原 App/真机验证

`PaperclipContractTests`、`PaperclipClientTests` 也加入现有 `MinisLogicTests`。独立宿主另外编译全部新 UI，不能用逻辑测试通过代替 UI 编译。

输出为 `native-paperclip-audit-results/` 下的构建日志、测试摘要和带截图的 `.xcresult`。使用 `PAPERCLIP_TEST_DESTINATION` 可指定实际已安装的模拟器；DerivedData 默认放在仓库外的 `~/Library/Developer/Xcode/DerivedData/LeoPhoneAgent-paperclip-audit`，可用 `PAPERCLIP_AUDIT_DERIVED_DATA` 覆盖。Linux 上脚本退出 2，明确报告未执行原生验证。

这些是隔离契约和原生控件测试，不能证明真实部署的 Better Auth 登录、真实智能体运行或真机后台行为。发布前还需用独立部署的中文 Paperclip 服务器完成：HTTPS 登录和退出、账号与组织切换、创建后断网及重试、回复断网及重试、状态与审批冲突、日志权限、重启草稿恢复、后台返回与动态字体检查。服务器任务不会因超时改用本机。

## 客户端边界回归

- 前台刷新只重读第一页：只加载一页时整体替换，已加载多页时按任务 id 合并、保留后续页，不能把列表截回第一页；失败按 15 秒起、2 倍退避到 2 分钟，成功复位。公司切换后的旧响应不能发布到新公司。
- 登录浏览器只允许当前配置的 HTTPS origin 导航；994 的 `/auth` 表单登录可以使用，不开放任意 HTTPS 外跳或未经支持的外部 OAuth 流程。
- 994 的任务创建去重键只保留 7 天。首次提交前持久化时间与请求编号；客户端保守的 6 天窗口结束后、时间异常或旧草稿没有时间时保留内容并要求核对服务器，禁止再发送同一创建。期限内沿用原编号，不能宣称永久去重。
- 首次提交被服务器明确拒绝的创建或回复保留正文并恢复编辑；写请求之前的健康/身份/任务读取失败（`.preflightFailed`，写请求确定未发出）同样恢复编辑并保留请求编号；只有写请求发出后的未知结果锁定原内容等待核对。此工作台当前不提供运行取消、附件或产物下载。

## 去重与退出边界证据

固定上游提交 `994d6edcdd4e15d5f9cc5cf8c135ac599104b86a`：

- `server/src/services/issues.ts` 的创建流程（9845–9900附近）对 `companyId + idempotencyKey` 使用事务级 advisory lock，并从 `issueCreateIdempotencyKeys` 查回原任务。237–239行规定幂等键保留7天，9864附近按此期限清理。客户端持久保存首次提交时间，保守地只允许6天内直接重试；旧草稿缺时间戳、设备时钟倒退、窗口过期均先停下让用户核对
- 同文件12245–12247附近按 `issueId + authorUserId + clientRequestId` 查回已有回复。未知回执不会自动生成新UUID或重发；草稿和请求编号按配置、组织、人类用户、任务隔离
- `PaperclipCookieVault` 为每个配置串行化 Cookie 写入和清除，清除首先撤销代际，再等待正在进行的写入完成，最后清空。旧回调即使晚到也不能回填；`clearLogin` 完成后还要通过配置与状态版本检查才能修改忙碌状态
- `PaperclipWebKitTests` 同时覆盖真实容器隔离和可控异步回归：写入中退出、旧代际迟到写入、切换配置后旧清除不能解除新配置忙碌状态
- 运行日志以64KB为一段，按服务端 `nextOffset` 增量读取并把 NDJSON 解析为可读文本（区分 stdout/stderr、去 ANSI）；运行中通过实时事件追加，截断或缺序时用 `log?offset` 补齐。运行与任务归属确认一次后缓存

## 工作台布局与状态操作回归

- 已连接列表只保留服务器名、组织和连接状态，以及“服务器设置”入口；登录、清除登录、添加和切换配置收进设置页。任务必须在首屏可点击
- 详情先展示任务标题、状态、说明和操作；URL、组织编号、用户编号和同步时间默认放在可展开归属区，绑定信息仍可查看
- 状态修改使用原生选择页和明确确认按钮，避免 iOS 26 List 内 Menu 的整行无障碍节点与实际触点不一致。确认后仍检查服务端返回状态；返回旧状态视为结果不确定，不关闭选择页
- UI 回归同时断言任务首屏可点击、登录控件不占主列表、详情技术编号默认收起，并保留截图。模拟响应测试不等于真实部署测试

## 有界的原生验证预算

`3aadde8` 的原生26项单测与空态旅程通过，但有数据旅程在首张截图时耗尽原120秒预算；AX等待已消耗约74秒，该失败的xcresult和截图超时诊断保留在原GitHub运行中；该轮录屏附件未成功最终化，不能作为可播放录屏证据。后续将已有验收拆为独立的列表创建详情、状态、回复、审批与受阻说明旅程，避免一个前序失败掩盖后续证据；操作、结果断言和截图均保留。每条测试默认240秒，硬上限300秒，workflow总预算不变；不自动重试把失败抹掉。截图先验证应用在前台，再通过XCUIScreen捕获真实屏幕，减少额外AX树查询。预算耗尽仍失败并导出诊断与录屏。

状态提交遇到未知回执时，选择页保存并锁定精确目标，仅显示“核实状态”。该操作只GET任务，逐项比对状态和受阻描述的负责人/行动；不匹配继续提示，不会重复PATCH。用户可取消后刷新重新决策。独立原生旅程以“服务器已写入但连接断开”模拟回执丢失，验证确认按钮消失、目标锁定、只读核实后服务器写入计数仍为1。

`4ea` 的32项单测通过，受阻旅程唯一失败为精确输入值的5秒只读等待超时：失败后AX记录已显示完整“请确认访问范围”且确认按钮启用，录屏也显示正确文本；单次AX读取超过4秒。因此仅将两处精确value等待统一为15秒，全旅程240/300秒预算和严格字符串相等断言不变，不重打字、不重发请求，原失败AX/录屏继续保留。此调整不改生产输入或状态逻辑。

## 1.53.3 实时进度与对话线程

- 只读轮询只在写请求进行中暂停（`canRefresh(active:mutating:)`），输入框聚焦、属性面板打开都不再暂停；发送成功后释放输入焦点；回到前台立即刷新。
- 公司级实时通道 `wss://<同源>/api/companies/{id}/events/ws`：建连前用同一 Cookie 快照新鲜确认身份，Cookie 经同一过滤后手写到握手头；每条事件校验 companyId，不符即断开；1/2/4/8/15 秒退避，断线期间回退轮询，重连后全量补拉；401/403 再确认身份后停止。
- 固定接口宿主用脚本化 WebSocket（`--showcase-fixture`）驱动运行中卡片、实时日志与实时评论；其余旅程模拟服务器拒绝实时通道（403）验证轮询回退。URLProtocol 无法承载 WebSocket，真实握手需真实部署联调。
- `testDesignShowcaseLight/Dark` 生成列表、详情、运行中卡片、内联审批、属性面板的浅/深色截图。独立宿主用原生 Markdown 回退渲染；主 App 注入端侧 `SelectableMarkdownView`。
