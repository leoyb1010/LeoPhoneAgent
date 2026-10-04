# 工作流、技能、例行任务与工作区中文化

## 固定输入与文件边界

- 上游固定提交：`994d6edcdd4e15d5f9cc5cf8c135ac599104b86a`
- 日期：2026-10-04
- 仅新增本组 `workflows-skills.zh-CN.json`、`workflows-skills.structural.json` 和本审阅记录
- 第一轮任务/智能体词库及其检查点未修改
- 原始输入取自固定提交的 `git archive` / `git show HEAD`，不把已应用中文层的工作树当原始源
- 结构补丁先于静态 AST 词库应用，每项包含文件、完整原始上下文、译文及命中次数

交付：1,914 条静态词条，521 条精确结构补丁，涉及 44 个结构变更文件。

## 范围

审阅并补充当前剩余报告中的 63 个实际源文件：

- CompanySkills 及 production、SkillStudio、SkillSources、TeamCatalog
- ExecutionWorkspaceDetail、ProjectWorkspaceDetail、Projects、ProjectDetail、Workspaces
- Pipelines、PipelineSettings、Routines/RoutineDetail 及 production
- Org/OrgChart 及 production、Goals/GoalDetail
- Routine、ScheduleEditor、Project、Workspace、ExecutionWorkspace、Skill 组件
- routine-sections、routine-triggers、folders、pages/skills、pages/agent-skills

包含技能安装/导入/分叉/来源同步/文件夹/测试运行/版本、团队安装风险与来源策略、工作区关闭前检查/服务控制/导出恢复/配置校验、例行任务草稿与版本恢复/计划/webhook 安全与连接测试、工作流阶段/审查/重试/事项流转等文案。

## 行为保护

### 调度：保留原始值，只本地化显示

`ScheduleEditor` 的小时选项原始英文从私有 `label` 字段移到 `rawLabel`。原始 `12 AM`、`12 PM`、AM/PM 解析正则及小时值保持不变，仅在下拉选项与摘要最终显示处转换为“凌晨 / 上午 / 中午 / 下午”。

- `buildCron` 与 `parseCronToPreset` 的逻辑不变
- 未切换为 24 小时制，未更改时区或 cron 字段
- 英文序数后缀仅在专用显示函数中映射为“日”，原条件和调用保持
- `TriggerWizard` 的星期枚举与默认 `Monday` 保持原样
- 星期原生选项增加显式 `value={day}`，显示中文星期；避免翻译 `<option>` 文本后隐式改变提交值
- 默认 `America/Chicago` 时区和时区选项原值保持不变

### 用户内容与协议

- 不翻译 API 字段、枚举比较值、查询键、事件名、仓库/模型/路径/命令标识或用户内容
- 不改变默认业务对象名称，例如新阶段名、生成的服务名、模板副本名
- `SkillStudio` 恢复操作写入的 `Restore of v${version.revisionNumber}` 属于操作记录元数据，本批刻意保留
- Webhook 提示的正文可读说明已中文化；认证标头、算法、JSON 示例字段、密钥表达式和发送规则保持原样
- 保留安装执行脚本、外部来源、未固定来源、不可回滚部分状态、密钥仅显示一次等风险信息

### 复数与技术缩写

未创建全局 `s → 空串` 词条。21 个带计数条件的 JSX 元素采用完整上下文专项补丁，只修改英文复数显示后缀，保留条件和计数表达式。

TeamCatalog 的 `a/p/r/s` 统计缩写单独整行改为“个智能体 / 个项目 / 个例行任务 / 个技能”，不误删技能计量。

## 验证

1. 521 条结构补丁全部按 `expected` 次数精确命中原始输入
2. 44 个结构变更文件全部通过 TypeScript AST 解析，继续应用全服务静态词库后仍通过
3. `{{...}}` 占位符逐字对比为 0 差异
4. 全服务词库合并无译文冲突
5. 服务中文化包 `npm test`：9/9 通过，包括协议/比较/路由/用户数据保留、上下文限定、幂等、动态模板不自动重写、toast 与 API body 区分、显示映射与原始诊断保留、词库安全检查
6. 固定原始源与中文结果的调度函数对照：374,976 组 cron 生成、解析和重复往返等价通过
   - 六类可选预设、24 小时、全部 5 分钟选项、7 个星期值、每月 1–31 日
   - 午夜、中午、全部小时、中文星期/月日显示通过
   - 自定义 cron、小时值、星期原值及默认时区不变
7. 全服务 `localize.mjs extract` 集成预检通过，无结构上下文冲突或 AST 错误

上述为本批源码、变换和功能对照验证，不等同于完整应用构建、上游测试套件、浏览器或真机验收；最终集成由服务主任务统一执行。

## 覆盖结果与保留项

最终集成报告中，本组 63 个审阅文件有 3,383 个静态 AST 候选，已翻译 3,307 个，显式保留 1 个，剩余 75 处（48 个去重值）。这些剩余是品牌、协议、命令、路径、标识示例、占位符、单位或快捷键：

- Paperclip、GitHub、skills.sh、Webhook、API、HTTPS、UTC
- `SKILL.md`、`origin/main`、`PAPERCLIP_*`、模型/仓库/工作区标识样例
- Shell 命令、运行配置 JSON、URL、文件路径与变量占位符
- `⌘S`、`j`、`k`、`Enter`、`a`、版本前缀 `v`、HTML 标点实体
- 可供运行时使用的选项示例 `high, medium, low`

动态剩余检测中的 6 项，5 项是已经中文化但保留 Paperclip/webhook 技术词的句子；另 1 项是刻意保留的恢复操作元数据。

这只是已识别显示入口的覆盖证据。未把普通 `.ts` 数据对象标签视为可以全局翻译，也未递归修改后端返回内容、插件文本、日志、用户文档或技能正文。后续新增入口、外部适配器提供的说明和运行时数据仍应在真实页面中核查。
