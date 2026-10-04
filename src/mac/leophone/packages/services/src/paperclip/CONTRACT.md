# Paperclip 服务契约

公共入口为 `@zcode/services/paperclip`（contract.ts）。所属现有 services 模块。

- PaperclipWorkspaceService 独占当前身份和远端快照；组件通过 UI hook 订阅。
- PaperclipTransport 由平台适配器注入；浏览器安全的业务服务不导入 Electron、fetch 或本地 Agent runtime。
- request 只传递 API 内容，signIn/signOut 的 Cookie 由原生安全会话持有。
- 所有写操作先冻结 server/company/user，验证 human session，保存持久回执，再发送。
- 断网不等于失败；幂等 create/comment 使用原回执键核实，其他 mutation 仅 GET 读回。
- 各异步世代分别保护身份、列表、详情和日志；过时响应不得修改新界面。

上游契约、事件顺序、迁移边界和验收详见 docs/specs/leo-paperclip-workspace.md。

## 人类会话健康准入（2026-10-04）

配置后的连接刷新、会话读取、原生登录窗口打开和提交前身份核对，都必须先读取 `/api/health`。只有 `deploymentMode: authenticated` 且 `status: ok` 才继续；`starting` 是已识别的启动状态，显示中文等待提示但不读取会话、不打开登录窗口、不提交任务。拒绝 `local_trusted`、缺失/未知模式、未知状态和畸形健康响应，绝不回退到本地执行。

`authReady` 在匿名健康响应中会被省略，因此缺失时允许继续认证；明确为 `false` 时暂停并提示管理员完成认证初始化。此字段如果出现必须为布尔值。依据固定上游 `server/src/routes/health.ts` 的公开/完整响应分支，不将可选字段误当成必填。

健康准入失败保留中文错误；健康恢复后用户可再次刷新或登录。健康准入失败不得调用 `get-session` 来接受本地信任模式的合成身份。
