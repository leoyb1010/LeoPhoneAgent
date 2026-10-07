# 中文化覆盖与验证记录

固定上游：`994d6edcdd4e15d5f9cc5cf8c135ac599104b86a`。记录日期：2026-10-05（发行层 1.1.6，数字取自本次 `localize.mjs verify` 与 `coverage-contract.mjs` 实际输出）。

## 最终源码快照数量

- 合并唯一词库：9411 条；实际用于静态替换的唯一源文本：8547 条。两者都不是页面数量
- 扫描源文件指纹：1121 个；报告文件（有候选或补丁）：607 个；含生成辅助模块在内的输出文件：617 个
- 结构补丁后静态候选：14504 处；实际中文替换：14164 处；明确保留：320 处；已中文且含技术标识：20 处；未审阅静态英文：0 处
- 精确源码补丁匹配位置：2883 处（结构补丁规则 2779 条，按 `catalogs/order.json` 顺序应用）；显示日期/数字 locale 变更：108 处；MDXEditor 官方 translation hook：93 个键
- 剩余带拉丁字母的动态模板：63 处，全部精确登记在 `catalogs/dynamic-preserve.json`，`coverage-contract.mjs` 退出 0。分类：中文含品牌/协议 46 处，可复制 CLI 命令 6 处，技术表示 8 处，业务默认标题/审计元数据 3 处。1.1.5 遗留的 `SidebarSection.tsx` 未登记模板 `${label} actions` 已由结构补丁译为 `${label} 操作`

静态分母来自结构补丁后的 AST；已经由结构补丁翻译的文字不会重复计数。不得把 14164 + 2883 解释成唯一完整句子数，也不能将源码门禁通过解释为所有页面运行态已验收。

## 覆盖矩阵

| 范围 | 文件数 | 静态中文替换 / 候选 | 技术保留 | 未审静态 |
|---|---:|---:|---:|---:|
| 初始化与认证 | 14 | 195 / 216 | 21 | 0 |
| 任务核心 | 9 | 460 / 463 | 3 | 0 |
| 智能体核心 | 12 | 805 / 845 | 40 | 0 |
| 审批与预算 | 13 | 302 / 303 | 1 | 0 |
| 后台配置 | 17 | 1197 / 1243 | 46 | 0 |
| 导航与全局错误 | 23 | 210 / 212 | 2 | 0 |
| 全站生产显示源码 | 607 | 14164 / 14504 | 340 | 0 |

“技术保留”列为候选减实译，含明确保留（320）与已中文含技术标识（20）。

全站还覆盖连接器、应用与聊天集成、权限、技能库、工作流、例行任务、工作空间、活动与运行记录、内置适配器配置、插件宿主和 Markdown 编辑器。分批词库 README 保留各轮审阅历史，最终状态以本记录和本次运行生成的报告为准。

## 保留原文与边界

- `preserve.json` / `contexts.json` 保留品牌、模型/协议标识、命令、路径、URL、环境变量、MIME、SHA、版本与代码示例；不能用通配符豁免任意新英文
- 用户标题、正文、名称、评论、文件与模型输出原样显示。重新发起任务的 `Re-issue (isolated):` 默认标题和版本恢复的 `Restore of v` 审计文字属于持久化业务数据，明确保留
- 原始 API/模型/CLI/插件错误与诊断保留；通用错误组件提供中文说明并可展开原文。外部插件自己的 UI、服务端日志、CLI 帮助与第三方返回内容未作字符串改写
- 动态模板允许清单按文件和完整模板精确匹配；新的可见英文会失败。AST 能识别的显示节点并不等于所有运行时生成内容；新增 helper 或外部 UI 必须人工复核
- 日期/相对时间/可读 cron/星期显示使用中文；时区、UTC 计算、金额和美元币种不变。供颜色/状态判断使用的 `due now` / `overdue by` 等 raw 值不翻译，只在最终显示处转中文

## 验证证据

- 固定 SHA、1121 文件 SHA-256、精确补丁次数、修改后 TS/TSX 解析、apply/verify 与重复应用通过；源码协议不变量门禁覆盖原始路由、原生表单 value、比较字面量与协议字段
- 便携调度回归覆盖 374,976 组输入，每组两轮编辑/解析；午夜、中午、24 小时、7 星期、31 日期、预设和自定义 cron 与原实现一致
- 上游共享包/插件 SDK 构建、UI TypeScript 类型检查、20 条实际 React/jsdom 中文 UI 测试和生产 Vite 构建通过；最后补充显示映射后已再次完整通过（20 条工具/调度测试、20 条 React UI 测试、类型检查、Vite build 3.29 秒）；浏览器终态另由 CI 留档
- 发现并修复显示标签参与 literal union、原生 option 隐式 value、DOM ID、测试标识、状态比较的风险；保留逻辑值并单独处理最终显示
- 首轮已发布 checkpoint 的 CI `37179968313`：中文登录/注册切换、401 中文提示、原始诊断展开/收起、页面 lang 与截图通过；审批页因测试 fixture 的 dashboard 形状错误失败。新版已使用有类型约束的完整 fixture，新增回归并保存失败截图/页面错误；新版多页浏览器验收等待新 CI，不能把首轮结果当最终全站结果
- 本地 Chromium socket 启动受限，允许重试仍失败；云浏览器无法访问本机临时地址。没有绕过限制或宣称本地像素验收通过
- 本地真实 HTTP/DB 启动在内存限制下退出（首次137，独立复核134 OOM），未获得 health。标准 CI 另行运行真实后端 smoke；fixture 冒烟不替代真实登录 Cookie、任务/评论及数据库契约
- 上游大包体积与无效动态 import 构建警告仍存在；生产 Docker、实际部署、收费模型执行、预算硬停止、迁移和备份恢复未验收

本次交付为源码级深度中文发行层。没有部署真实服务器，不宣称“所有外部内容零英文”或“生产部署已验收”。

## 2026-10-04 浏览器复核修正

最终首轮多页浏览器 CI `37182613415` 的登录与审批空态截图可读。原烟测把智能体导航标签命中当成页面成功，独立像素复核发现其实际是 React ErrorBoundary（fixture `/instance/settings` 缺少 `experimental`）；因此撤回该页通过结论。`pageerror` 为空不能证明被 ErrorBoundary 捕获的渲染正常。

窄修为浏览器 fixture 添加完整 InstanceSettings / experimental 字段，给正常版和 production 版真实 Agents 页面增加渲染与“新建智能体”点击回归。浏览器逐页检查正文空态、核心控件可操作、ErrorBoundary 不存在，并捕获 React 边界 console 错误；不再用导航标签作为成功条件。

设置页组织名保持原值，旧断言因 CSS uppercase 改变 `innerText` 而误报；现在检查原始 textContent 和输入 value。设置页唯一未隐藏的原生 file input 使用中文可访问包装；文件类型、File 对象、原名、多选能力、disabled/ref、上传回调及重置行为保留，并有两个 React 回归。其他 file input 本来已经 hidden/sr-only。额外修复智能体空态按钮 action 显示为中文。

窄修本地类型检查、25 条 React 测试、构建通过；新多页像素结果仍等待补丁发布后的 CI，不能沿用旧烟测的智能体 passed 字段。

烟测 API 现在逐路径登记，未知请求返回501并记录后使测试失败，不再默认返回空数组。已核审批/智能体/设置/预算读取的 dashboard、membership、InstanceSettings、SidebarBadges、BudgetOverview 和明确数组型列表端点；实时 WebSocket 在该静态 fixture 中明确不提供，真实事件验证属于后端集成。

在核对烟测预算页时，补齐其 audit-navigation.ts 五个最终显示标签（活动/运行/费用/预算/时间线）；原 value、href 与带筛选参数的路由计算保持不变，新增直接回归。该例也说明静态候选零剩余不能替代跨模块的像素验收。

2026-10-04 CI `37183754042` 中，正常智能体主体和创建弹窗已呈现，新增未知请求门禁继续阻断了漏登记的环境能力与默认头像端点。补充完整 EnvironmentCapabilities，并将唯一默认头像请求显式设为上游公开的503临时不可用响应，覆盖其内置图标回退而不启动图像worker。这是静态UI fixture范围，不能声称头像生成服务已验证。未知请求仍全部失败，不作通配放行。该轮设置与预算尚未执行，不宣称通过。

## 最终五页浏览器证据

CI [37184319250](https://github.com/leoyb1010/LeoPhoneAgent/actions/runs/37184319250) 的中文服务 job `111383001150` 成功；[工件11296197410](https://github.com/leoyb1010/LeoPhoneAgent/actions/runs/37184319250/artifacts/11296197410) 含登录、审批、智能体、设置、预算5张截图，已逐张查看，主体正常，中文可读，无错误边界或内容遮挡。实际执行了登录/注册切换、401中文提示与诊断展开、智能体创建弹窗打开/关闭、组织名原始输入值、中文文件控件、预算控件及未知API零项断言。该次源码快照为 `fd1f0032a441cfed770608ddfeffca7f922c0049`。

这5张图左下角仍显示上游匿名身份回退 `Board`。最后两处精确源码补丁将**缺少会话姓名时的显示回退**改为中性的“用户”，不暗示管理员权限，保留任何真实姓名（包括恰好名为 Board 的用户）；直接执行两版源码表达式的回归覆盖缺失/空白姓名和真实原名。此最后显示修复的新版像素仍由后续 CI 记录。其他页面不扩大本轮烟测范围。

## 2026-10-07 中文版式与显示整理（1.1.7，catalogs/ui-layout-polish.structural.json）

用户反馈“新建任务后文字乱七八糟”。本轮在隔离的本地真实服务（`PAPERCLIP_HOME` 指向临时目录、内嵌 PostgreSQL、`local_trusted`）上灌入组织/项目/6 个不同适配器与状态的智能体/21 个任务（含评论、子任务、阻塞、标签）/3 条审批/3 条例行任务/40 条费用后，用 Playwright 对 45 个场景 × 5 个宽度（1440/1100/900/640/390）× 明暗主题共 450 张截图做程序化检查（竖排文字、裁切、遮挡 elementFromPoint、原始语法/枚举/UUID、英文残留、微型字号、横向溢出），截图与 findings 存档于审计工作目录 `pc-ui-A/{before,after}`。

修复全部落在发行层，可从干净上游重放：

- `catalogs/ui-layout-polish.structural.json`（158 条精确上下文规则，登记在 `catalogs/order.json` 末位）：新建任务对话框为英文 "For" 预留的 24px 标签列改为图标列并保留 sr-only 中文名；搜索页原始运算符提示改为“中文说明 + 语法”可点击示例芯片，焦点态建议与 ⌘K 快速筛选同样中文在前、语法居次，编号示例使用当前组织前缀而非固定 `PAP`；404 页标题/说明、运行记录系统消息计数、恢复横幅已保存消息、活动摘要步骤标签、交互卡片标题（`lib/issue-thread-interactions.ts`）与回复受众说明（`lib/interaction-audience.ts`）、实验功能页 `footnote` 属性、信任预设说明、主题切换名称、看板列标题（改走 `displayStatus`）、密钥页“文件夹/平铺”、加入/退出按钮、运行记录数量说明、智能体概览“审计”链接、目标层级等 lib/属性/枚举位置的英文改为中文；按英文语序逐词拼接的 23 处计数模板改为整句（如“已保存 3 条消息，等待恢复处理。”“3 条系统消息”）；智能体详情摘要行标签 `shrink-0 whitespace-nowrap`、值容器 `min-w-0`、头部操作按钮组允许换行、任务对话分隔标记标签不换行、技能工作室面板标题不按字换行
- `overlays/zh-cn-layout.css`（由 `structural-patches.mjs` 写入 `ui/src/zh-cn-layout.css` 并在 `index.css` 紧随 `@import "tailwindcss"` 引入）：中日韩回退字体栈；`--text-nano/--text-micro` 由 10/11px 抬到 11/12px；标签类元素 `word-break: keep-all` + `overflow-wrap: anywhere`；徽章内长技术标识可换行而不撑破卡片（绝对定位计数角标除外）；列表工具栏可换行且搜索框保留最小宽度（640–900px 下不再压住视图/筛选按钮）；移动端主内容末尾预留底部导航高度
- 词库修正：`&rarr;`/`&gt;`/`&lt;`/`&middot;` 等 7 条译文改为真实字符（原先以字面量 `{"查看全部 &rarr;"}` 渲染出实体文本）
- `native/ui-test-assertions.patch.json` 新增 72 条 C 类断言（ThemeToggle、interaction-audience、issue-thread-interactions、completed-activity-summary、MembershipAction、KanbanBoard），对应上游测试在候选树全部通过；本轮之前已存在的 35 项上游测试失败（Search 11、AgentActionButtons 7、FrontmatterPanel 5、AuditRuns 2、KanbanBoard 3、trust-policy-ui 2、TaskChatMarker 1 等，均为更早轮次中文化所致）未在本轮处理
- `tests/ui-layout-polish.test.mjs`：回放规则（上下文唯一、可逆、插值不丢失）、搜索/对话框/交互标题断言，并对候选树做规则级扫描：不允许再出现“中文片段 + 同分支计数三元 + 中文片段”的英文语序拼接模板，不允许字面量中残留 HTML 实体

验证（候选树）：`localize verify`、coverage contract、协议不变量、`npm run test:full` 全绿；UI typecheck 与生产构建通过。审计计数（去重，排除侧栏悬停按钮/命令面板滚动区/底栏滚动中经过等固有遮挡）：竖排文字 38 → 11（剩余为技能工作室内 SKILL.md 英文正文片段与 900–1100px 下三栏布局本身过窄）、遮挡 34 → 15（集中在技能工作室 900/1100px 三栏最小宽度 280+240+360px 超出可用空间）、裁切 4 → 8（全部是同一条用户输入的无空格超长英文标题，后一轮多出看板视图场景）、截断 508 → 476、英文文本 667 → 644、混合英文 85 → 75、微型字号 1106 → 1096（条目仍在但字号已整体抬高）。

未覆盖/遗留：搜索结果摘要中的 `Status: in_progress - Priority: medium` 与运行标题 `Connect Anthropic`、活动条目 `environment_lease`、任务错误 `The run failed (configuration_incomplete)` 均为服务端持久化/生成文本；连接器与插件目录描述、技能 SKILL.md 正文、智能体输出为外部内容；`ui/src/lib/*.ts` 仍有约 300 处 helper 生成的英文句子未纳入自动词库（本轮只处理在渲染审计中出现的文件）；技能工作室 900–1100px 的三栏布局需要上游调整最小宽度；目标层级标签与“Routine not found”未在 UI 源码中定位。

## 2026-10-07 第二轮：helper 文案、服务端提示、技能工作室布局与上游测试断言

在第一轮基础上继续，全部落在发行层并可从干净上游重放（`prepare.sh` → `check-upstream.sh` 通过）：

- `catalogs/ui-helper-copy.structural.json`：1049 条整行精确规则，覆盖 `ui/src/lib/*.ts`、`components/task-chat/*.ts`、`pages/*` 等 helper 函数里自动词库不认识的英文显示字面量（工具活动标签 148 条、运行摘要、工作区访问状态 55 条、应用目录文案、技能策略拒绝原因、管道条目说明、JSON 表单校验、文件查看器、队列消息、实验功能开关的 aria-label 等）；规则只改字符串字面量并保留全部 `${}` 插值。未译项逐条登记在 `catalogs/helper-copy-preserve.json`（180 条：日志/异常/内部键、持久化业务文本、发送给模型的提示词、原始 HTTP 诊断）；`tests/ui-helper-copy.test.mjs` 对候选树做门禁扫描，新增的英文句子字面量未入规则或登记即失败
- `catalogs/ui-layout-polish.structural.json` 扩到 219 条：新建任务对话框标签改为可见的自适应宽度“分配给”（不再隐藏为图标）；技能工作室三栏布局阈值 900→1280px（窄屏改为标签页，900–1100px 不再塌陷/互相遮挡）；搜索筛选芯片与菜单的前缀和枚举值走 `displayStatus`（“状态：待办”而非 `Status: Todo`）；时长与相对时间全站统一为“N 秒 / N 分 N 秒 / N 分钟前”（`timeAgo`、`utils.relativeTime`、搜索结果、任务对话状态胶囊、时间线、运行记录、受阻收件箱）；看板“再显示 N 条 / 显示 N / M 条”、时间线页脚、经验记录句子、文件芯片无障碍名称等拼接模板整句重写；列表行标题、收件箱错误摘要、会话 ID 补 `title` 提示
- `native/server-display-copy.patch.json`（26 条，登记在 `apply-native-cli-auth.mjs`）：服务端生成后原样显示在网页里的恢复通知标题/正文/下一步、“恢复负责人 / 需要管理者决定”等元数据行、排队消息阻塞原因、运行事件 `run started` / `run presentation resolved` 改为中文；状态码、枚举、payload 字段与事件类型不变
- `overlays/zh-cn-layout.css`：主侧栏导航细滚动条常显 + 上下滚动阴影（900px 下“最近任务”分组不再像被账号区盖住）；段落内短强调词 keep-all；底部导航计数角标不再裁掉末位数字；徽章换行只作用于可换行芯片列表，表格/看板状态徽章保持单行
- `native/ui-test-assertions.patch.json` 增至 188 条：Search、AgentActionButtons、FrontmatterPanel、AuditRuns、KanbanBoard、trust-policy-ui、TaskChatMarker、Timeline、CloudAccessGate、WorkTimelineChart、utils.date-time 等本轮与此前轮次失败的上游 UI 测试断言按当前中文产物更新，`vitest run` 这 17 个文件 197/197 通过。整个 `@paperclipai/ui` 包的上游测试仍有大量英文断言失败（本轮之前已存在，见下）

渲染审计（同一本地真实服务、45 场景 × 5 宽度 × 明暗、450 张截图，`pc-ui-A/after`）去重计数 第一轮前 → 本轮后：竖排文字 38 → 4、遮挡 34 → 1、裁切 4 → 8、截断（无提示）508 → 97（另有 384 处带 title/aria-label 的正常截断）、英文文本 667 → 663、混合英文 85 → 75。

剩余项及原因：
- 英文文本：技能名（`paperclip-board` 等技术标识）、连接器目录描述（服务端 MCP 注册表数据）、插件清单名称/描述/包名（外部插件内容）、适配器 id（中文标签下的技术次要值）、用户输入的长标题/URL、智能体错误输出、SKILL.md 正文片段、本地账号邮箱
- 混合英文：搜索结果摘要中的智能体续写文本（服务端持久化），以及含品牌名的中文句子（误报）
- 竖排：技能工作室 SKILL.md 正文在中栏的英文连接词、搜索结果高亮 `<mark>` 跨行（误报）
- 裁切：用户输入的无空格超长英文标题
- 上游 UI 包整体 vitest：2637 个失败 / 4697 个通过（本轮前即为英文断言失败，门禁仍以三个 zh-CN 测试文件 + 本轮登记的 17 个文件为准）
