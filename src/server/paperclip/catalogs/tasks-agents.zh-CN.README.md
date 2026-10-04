# 任务与智能体中文化审阅记录

## 固定来源与交付范围

- 上游：`paperclipai/paperclip`，提交 `994d6edcdd4e15d5f9cc5cf8c135ac599104b86a`
- 审阅日期：2026-10-04
- `tasks-agents.zh-CN.json`：1,846 条扁平「英文源文案 → 简体中文」词条
- `tasks-agents.structural.json`：386 条带文件名、完整原始上下文、目标文本及 `expected` 次数的精确源码补丁，涉及 51 个文件
- 必须先对固定英文原始源应用结构补丁，再应用 AST 静态词库。不可对已经中文化的工作树重复套用原始上下文
- 未编辑上游共享 API 枚举、用户输入内容、协议字段、持久化连接名称或 Git/文件路径；未提交、推送、发布

本批覆盖任务列表与详情、新建任务、新建智能体、智能体列表/详情、配置与登录、文档/附件、关联任务、恢复操作、运行台账、审批与提问、技能分配，以及相关可访问性标签。

实际入口中的 `Agents.production.tsx` 和 `AgentDetail.production.tsx` 均已纳入；不能因为文件名包含 `.production` 而跳过。

## 深层显示入口

- 新建智能体真正流程位于 `components/new-agent/`，而非仅 `pages/NewAgent.tsx`
- 已补 `AgentBasicsDialog`、`AgentProviderConnection`、`NewAgentSetup` 的动态标题、登录 CTA、表单校验、模型/API 配置提示与错误
- `AgentConfigForm` 的静态与动态配置、身份验证错误，以及 `agent-config-primitives.tsx` 的 41 项帮助提示均已处理
- `Agents`、`Agents.production`、`AgentProperties` 与 `agent-config-primitives` 的本地 `roleLabels` 使用中文显示值，保留原共享枚举与键
- `StatusIcon` 使用 `displayStatus` 的局部别名，避免与组件内 `displayStatus` 变量重名；阻塞原因、状态修改 aria 已中文化
- `PriorityIcon` 的优先级修改 aria 已中文化；优先级协议值保持原样
- 任务快速预览、依赖任务状态、工作区状态与运行台账展示函数调用中文显示层
- 审批卡片状态/交互类型、恢复分类/说明/结果采用限定函数或显示映射补丁，避免误改状态判断
- 新建任务的上传警告、失败文件数、打开任务 CTA，以及常用计数、确认、提示、可访问性标签已补动态模板
- 5 处 JSX 英文复数后缀已专项修复；只调整显示字面量，保留原条件与计数表达式

## 术语

沿用服务统一术语：智能体、任务、组织、管理者、总览、成果文件、工作成果、适配器、例行任务。

状态显示与 `ui/src/i18n/zh-CN.ts` 保持一致：待规划、待办、进行中、待审核、受阻、已完成、待批准、异常。用户可见错误说明中的“错误”仍按自然语义使用。

保留品牌和技术标识，包括 Paperclip、Codex、Claude、OpenAI、OpenRouter、Anthropic、OpenCode、Cursor Cloud、Hermes Gateway、ACPX、API、CLI、HTTP、JSON、Markdown、MIME、模型 ID、环境变量名与命令参数。

## 验证证据与边界

在固定提交的原始源快照上逐项验证：

1. 全部 386 条 `from` 按对应 `expected` 次数精确命中
2. 应用全部结构补丁后，51 个变更文件全部通过 TypeScript AST 解析
3. 对结构补丁结果继续执行静态 AST 词库转换，全部通过解析
4. `{{ ... }}` 模板占位符逐字对比，0 差异
5. 与同时存在的其他服务中文词库比较，0 重复键译文冲突
6. 77 个审阅源文件中，原始 AST 静态候选共 2,624 处，词库命中 2,575 处；结构补丁后剩余 43 个静态候选均属于保留品牌、协议、路径、单位、按键名或实体符号

以上是本分工的源码及词库验证，不是全站中文覆盖率。未运行完整 Paperclip 类型检查、构建、测试套件或浏览器/真机界面验收；这些应由服务集成统一完成。不得将 AST 解析成功等同于构建成功或交付可发布。

## 明确保留的静态候选

Paperclip Computer、Paperclip、Paperclip Runner、Claude (ACPX)、Grok Build (ACPX)、OpenCode、Cursor Cloud、Hermes Gateway、OpenRouter、OpenAI、Anthropic、kimi-for-coding、ID、v、tok、KB、Option、Shift，以及 URL、文件路径、`TOOLS.md`、`application/octet-stream`、HTML 实体符号。

`My ${provider} subscription` / `My ${provider} API` 的默认业务连接名称未改写，以免把源代码中文化变成对持久化用户数据的修改。

## 尚需定点处理的复杂动态显示

以下不是静态 AST 候选，不能用静态词条命中率推断已覆盖。原始提交行号用于后续定位；应仅对显示上下文作精确补丁，不对用户返回值或协议进行递归翻译。

- `AgentConversationSidebar.tsx:61`：智能体数量模板的词语完全位于条件表达式内，静态提取器不会发现完整句子
- `IssueThreadInteractionCard.tsx:2391,2442,2481`：第三方账号授权的主语/身份说明、重新发送授权链接句子
- `IssueThreadInteractionCard.tsx:2979`：嵌套的恰好/范围选项数量模板
- `IssueWorkspaceCard.tsx:76`：带 `label ?? "value"` 的复制 aria
- `IssuesList.tsx:628`、`LegacyIssuesList.tsx:614`：跨子任务运行数量汇总的嵌套复数模板
- `SidebarAgents.tsx:159`：通过 `builtInStatus.replace(...)` 拼成的内置智能体状态文案
- `issue-properties/IssueProperties.tsx:1066,1068,1863`：审查阶段与参与者组合文案、审查者/审批者动态搜索框
- `skill-studio/AgentsUsingSkillDialog.tsx:59,239,370`：使用技能的智能体数量及带版本号的 Latest 文案
- `IssueDetail.tsx:4345`：解除暂停后部分任务未能启动的动态错误说明
- `AgentDetail.tsx:1762` 等直接嵌入 `lastRun.status` 的模板：需使用显示映射，不能改写运行状态原值

此外，由服务器返回的智能体定义/诊断、插件文本、运行日志、用户文档与智能体消息不是本词库可以安全覆盖的静态界面文案。系统错误需要保留原始诊断并提供中文解释，不能替换用户或第三方内容。
