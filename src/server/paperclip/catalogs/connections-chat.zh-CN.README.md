# 连接与聊天中文词库

## 范围与交付

- 英文基线：`paperclip-reference` 的 `HEAD`，固定提交 `994d6edcdd4e15d5f9cc5cf8c135ac599104b86a`；所有源码均通过 `git show HEAD:<path>` 读取，不读取已中文化的工作树作为英文依据
- 范围：`ui/src/features/connections/**` 与 `ui/src/pages/apps/chat/**`
- 枚举 `git ls-tree` 得到 35 个非测试 TS/TSX 文件（27 个 TSX），以及 17 个测试文件
- `connections-chat.zh-CN.json`：1120 个扁平英中词条；与全部现有词库相同英文使用相同译文
- `connections-chat.structural.json`：268 条精确补丁，涉及 22 个文件，每条均有 `expected: 1`
- 仅修改本组词库、结构补丁及此说明；未修改上游源码，未 commit 或 push

## 补齐内容

1. 聊天连接、邮件收件箱、Slack 身份关联与头像设置、Discord/Telegram/Teams/GitHub/Photon 引导、GitHub 自动评审与访问配置
2. OAuth/MCP 安全登录、身份归属及授权范围、重新连接与保留凭据说明、工具和智能体访问摘要
3. 删除/断开连接的具体影响、Teams 文件投递不确定状态、重复消息风险、访客隔离限制及受限权限提示
4. AST 自动提取遗漏的 helper、调用参数、错误状态 setter、步骤数组、ARIA 文案和动态模板
5. 聊天页签、连接/投递/文件传输状态、GitHub 评审状态仅在展示层映射为中文，原始状态值保持不变
6. `remote-mcp/providers.ts` 明确声明为 presentation-only 元数据：只翻译说明、步骤、占位提示及帮助，保留服务名、id、URL 和能力字段

## 覆盖与保留项

基线当前提取器在本范围识别 1230 个静态 AST 候选，其中 1214 个有中文翻译。结构补丁先行后，AST 又执行 1199 个替换；该数字不包含结构补丁直接完成的静态和动态翻译。

最终静态提取剩余 16 个英文节点均为有意保留的技术名词、品牌、命令或示例 URL：

- Vercel Connect、Zapier MCP URL、Microsoft Teams
- Arcade-User-ID
- /status、/new、/close
- Zapier MCP、通用 MCP、Google Sheets 的示例 URL（含重复出现）
- Webhook（三处）、GitHub ID、· GitHub ID

本范围已审阅的源码内普通静态界面文案没有已知遗漏。动态模板中仍保留 CSS、路由、请求头键、DOM 标识、文件名、命令及品牌。用户、组织、智能体、连接和仓库名称以及用户输入均保持原样。

明确不翻译：

- `SetupPrompt.tsx`、`SlackSetupPrompt.tsx`、`GitHubSetupPrompt.tsx` 中的模型提示词与实例上下文
- Slack manifest 中外部协议配置、机器命令与用于发送的测试消息文本
- `connectionNameForGrantKind`、`defaultAiConnectionName` 等默认名称逻辑；`My ${entry.name} ...` 等会传给 API 的默认连接名
- 外部服务/API 返回的动态字段、诊断、验证详情及第三方内容；本词库不会猜译这些数据
- 测试源、业务枚举、条件、URL、调用参数中的协议值与权限字段

因此，“本范围源码内界面文案覆盖”不等同于所有第三方/API 动态内容都已中文化。错误展示的统一处理由主工程现有中文错误层负责，原始诊断仍保留。

## 验证

2026-10-04 04:58 UTC 快照：

- 将当时所有 `*.zh-CN.json` 合并（9410 条唯一词条）：零冲突
- 从 `git show HEAD` 在内存按顺序应用当时所有 `*.structural.json`（2031 条）：每条命中数均符合预期
- 使用现有 `transform()` 验证全部结构改动 TS/TSX，以及本范围所有 35 个生产文件：解析通过
- 本范围 52 个 TS/TSX（含 17 个原始测试文件）均可解析
- 发行层 `npm test`：9/9 通过，涵盖仅改展示节点、上下文隔离、幂等性、动态模板保护、请求数据保护、状态/错误映射及词库冲突检查
- 未运行完整上游 UI 类型检查、构建、浏览器或端到端测试；由最终整合步骤覆盖

结构补丁必须先于普通 AST 替换，且按数组顺序应用。后续精确补丁可以依赖前一条补丁的展示文案；不要排序数组内的补丁。
