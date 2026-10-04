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

## 任务受阻状态（2026-10-04）

手动把任务改为 `blocked` 时，确认框必须要求用户填写“解除受阻所需操作”，trim 后为 1–2000 字符；不自动编造行动或责任人。服务层在任何网络请求前再次校验并将裁剪后的内容存入操作回执。PATCH 精确发送 `unblockDescriptor: { owner: { userId: receipt.binding.userId }, action }`，责任人为操作绑定的人类账号，不接受 UI 传入其他 owner。

依据固定上游 `packages/shared/src/validators/issue.ts` 的严格 owner/action 结构及 `server/src/routes/issues.ts` 的 blocked admission。其他状态继续仅发送 status。未知结果与重启恢复仍只 GET 读回状态，不重复 PATCH；保留原行动文本和身份用于核实。

### 受阻回执与回复草稿核实

受阻成功回执和未知结果读回必须同时匹配 `status: blocked`、原回执的 `unblockDescriptor.owner.userId` 和裁剪后的 action，其他人写入的不同受阻说明不能当成本次确认。

回复核实成功由服务产生精确的 `receiptId + server/company/user + issueId + body` 确认标记。编辑器只清空由当前编辑器提交、关联同一回执、正文仍未修改的草稿；普通评论相同正文、其他回执和人工解除都不能触发清空。

评论作者标签由返回的非空身份字段决定：authorUserId 优先显示“用户”，其次 authorAgentId 显示“智能体”；缺失、空值或空白均不能推断身份，显示“未知作者”。
