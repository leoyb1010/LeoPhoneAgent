# leo-screen 桌面写操作审批

状态：本节点实现，待 Pro 本机门禁与实机验收。关联审计项：「默认权限档等同免审批，电脑操作工具没有独立确认」。

## 背景

Mac Host 把随包 Peekaboo 4.9.4 登记为用户级 MCP 服务 `leo-screen`（`packages/desktop/src/host/leo/registerPeekabooMcp.ts`）。
CLI 权限服务（`apps/zcode-cli/packages/core/src/permission/service.ts`）原先对 `yolo` 与默认档 `guarded`
直接放行所有非 alwaysAsk 工具，所以默认状态下 Agent 可以不经确认点击、输入、启动或退出任意应用。

## 规则

1. 判定只看真实 MCP 身份：`descriptor.serverName === "leo-screen"`（大小写、首尾空白不敏感）加 `descriptor.toolName`，
   再加本次调用入参里的 `action`。不看模型可见名、UI 别名、工具描述或 annotations。
2. 观察工具保持免确认，沿用原有模式语义：`image`、`see`、`inspect_ui`、`analyze`、`permissions`、`sleep`、`verify_state`、`list`。
3. 混合工具只有明确的只读 action 免确认：`app` / `window` / `menu` / `menubar` / `dock` / `space` 的 `list`，
   以及**不带 `outputPath`** 的 `clipboard get`。缺省 action、未知 action、其余 action 都是写操作。
   `clipboard save` 会写文件；`clipboard get` 带 `outputPath`（含空串）同样会写文件
   （Peekaboo v4.9.4 `ClipboardTool.swift` 149-153，后台模式允许），都算写操作。
4. 其余工具（`click`、`type`、`press`、`hotkey`、`scroll`、`swipe`、`drag`、`move`、`set_value`、`select_text`、`action`、
   `dialog`、`open`、`browser`、`agent` 以及以后新增的任何工具）默认是写操作。
5. 写操作在所有权限档的判定顺序：
   - `auto` → deny（与现有 auto 保护一致）；
   - 配置的 `disallowedTools` 命中 → deny；
   - 项目 deny 规则命中 → deny；
   - Plan 开启 → deny（Plan 不允许桌面写操作）；
   - 项目 allow 规则或会话 allow 规则精确命中这个工具名 → allow（保留用户已经针对该工具给过的授权）；
   - 其余一律 ask，规则号 `leo.screen.write`。`yolo` 与默认 `guarded` 不再直通。
6. ask 结果带 `alwaysAsk` 标记：PreToolUse hook 的整体 allow 不能抹掉这次确认；PermissionRequest hook 仍可应答（与 workflow 确认同一出口）。
7. 禁止代答：写操作的 ask 带结构化标记 `autoApproval: "forbidden"`，由 core 权限判定产出，
   沿 PermissionRequested 事件 → broker 请求 / v3 反向 RPC 参数 → reducer 的 PendingPermission → v3 恢复快照 /
   v4 pending interaction → services `ZCodePermissionRequest`（实时、事件流、恢复三条投影）→ Host 透传。
   Host 手机远控（`packages/desktop/src/host/leo/link/session.ts`）的两个自动出口——全自动下的新请求、
   切到全自动时批量放行挂起审批——见到该标记一律不代答，改为下发给人。模式本身不算授权；
   用户在手机上点过「本任务都允许」（同一工具 + 目标）仍照常生效；人明确作答照常送进内核。
   Host 只认这个字段，不按工具名、描述或 UI 别名推断。字段可选：旧 payload 缺省照常解析，语义同旧版。
8. 审批复用现有权限请求链路与选项（允许一次 / 本项目始终允许 / 拒绝），不新增服务、存储或 UI 别名层；工具结果与错误语义不变。
9. 官方 CUA（可信 authority 验证通过的 server）不叠加此规则，继续走它自己的授权门。

## 所有者与接口

- 分类：`apps/zcode-cli/packages/core/src/mcp/leo-screen-policy.ts`（纯函数）。
- 挂接：`createMcpToolEntry` 只为 `leo-screen` 条目声明 `resolvePermissionCapability`，写操作返回 `explicitApprovalRule`。
- 判定：`PermissionService.checkPermission` 在 guarded 危险命令与 yolo/guarded 直通之前处理 `explicitApprovalRule`，ask 时给出 `autoApproval: "forbidden"`。
- 透传：`core/tool/executor/{permission-request,events}.ts`；contracts `PermissionRequestedPayload` / `PermissionBrokerRequest` / `PendingPermission` / reducer；
  bootstrap `session-mapper.ts`、`interaction-broker.ts`、`product-projection.ts`；shared strict schemas 与 `ZCodePermissionRequest`；
  services `zcodeTaskServiceAdapter.ts` 三个投影；ui `pendingInteractionAdapter.ts`。
- 拦截：Host `link/session.ts` 的 `mayAutoApprove`。

## 验收场景

| 场景 | 期望 |
| --- | --- |
| guarded（默认）/ yolo / build / edit 下 `click`、`type`、`app launch` | ask，`ruleId = leo.screen.write` |
| 同上档位下 `see`、`image`、`app list`、`window list` | 与改动前一致（guarded/yolo 直接 allow） |
| `app` 不带 action、带未知 action | ask |
| Peekaboo 新增未知工具 | ask |
| Plan 开启时 `click` | deny |
| `disallowedTools` 或项目 deny 命中 `click` | deny |
| 项目 allow / 会话 allow 精确命中 `mcp__leo-screen__click` | allow |
| 项目 allow 只命中别的工具名 | 仍 ask |
| PreToolUse hook 整体 allow | 仍 ask |
| 第三方 MCP 服务也叫 `click`（serverName 不是 leo-screen） | 不受影响，沿用原模式语义 |
| `auto` 模式 | deny |
| `clipboard get` 不带 outputPath | 原模式语义（guarded/yolo allow） |
| `clipboard get` 带 outputPath（含空串） | ask |
| 手机已开全自动时来的 leo-screen 写操作审批 | 不代答，下发 `approval.request` |
| 先问我时挂起的写操作审批，再切全自动 | 普通审批放行，写操作保持挂起 |
| 重连 / 接管后补交的恢复 pending 带标记 | 不代答 |
| 手机对同一工具 + 目标点过「本任务都允许」 | 后续同类审批照常自动放行 |
| v3 事件 / 恢复快照携带标记 | 过 strict schema，标记不丢；旧 payload 无标记照常解析 |

## 剩余验证（Pro 本机）

- `pnpm leo:test:agent`、core 包 vitest、`pnpm typecheck`、`pnpm lint`。
- 实机：默认守护档让 Agent 点击一次，确认弹出审批卡；`see` 不弹窗。
- 版本偏斜：v3 strict schema 随 `packages/shared` 打进桌面端。CLI 与桌面同包分发时无偏斜；
  若新 CLI 连旧桌面，旧桌面的 strict schema 不认 `autoApproval`，会丢弃这条 permission 事件（gate 不会被放行，但卡片不显示）。
  需要在 Pro 侧确认没有独立升级 CLI 的路径。
