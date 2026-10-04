# Paperclip 服务契约

公共入口为 `@zcode/services/paperclip`（contract.ts）。所属现有 services 模块。

- PaperclipWorkspaceService 独占当前身份和远端快照；组件通过 UI hook 订阅。
- PaperclipTransport 由平台适配器注入；浏览器安全的业务服务不导入 Electron、fetch 或本地 Agent runtime。
- request 只传递 API 内容，signIn/signOut 的 Cookie 由原生安全会话持有。
- 所有写操作先冻结 server/company/user，验证 human session，保存持久回执，再发送。
- 断网不等于失败；幂等 create/comment 使用原回执键核实，其他 mutation 仅 GET 读回。
- 各异步世代分别保护身份、列表、详情和日志；过时响应不得修改新界面。

上游契约、事件顺序、迁移边界和验收详见 docs/specs/leo-paperclip-workspace.md。
