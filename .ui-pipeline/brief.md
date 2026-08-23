# UI Brief

## Outcome

- User-visible outcome: Android 用户可明确选择“CLI 官方账号”或“使用 LeoPhoneAgent 模型”，从产品内完成登录或直接启动，不再遇到含糊的授权错误。
- Success signal: Claude/Codex/Grok 的兼容模型以无密钥落盘配置桥接；四家官方登录入口可达；Fold8 展开/封面态没有按钮挤压或英文残留。

## Users and situation

- Primary users: 在 Android PRoot 中运行编码 Agent 的 LeoPhoneAgent 用户。
- Job to be done: 安装 CLI 后立即完成账号或模型连接，并在聊天或终端里可靠运行。
- Environment and devices: Android 8–16 ARM64；主验收 Fold8 1768×2208 展开态与 1080×1728 封面态。
- Visitor mode (`Persuade` / `Operate` / `Read` / `Experience`): Operate

## Product truth

- Unique mechanism: App 已持有多家模型配置，同时在私有 PRoot 中运行官方 CLI；两层通过瞬时环境与无秘密配置文件桥接。
- User's real scene: 用户已在 LeoPhoneAgent 配好模型，却被 CLI 再次要求官方登录或报授权不兼容。
- Primary change created: 授权来源成为显式选择；兼容模型映射到各 CLI 官方支持的 gateway/provider 配置。
- Real proof, content, data, and assets: ProviderRepository、CLI 版本/登录状态、官方文档、Fold8 截图与 UI tree。
- Category rut and predictable opposite: 不做重复安装卡和技术错误弹窗；改成账号状态、模型来源、主动作一眼可读的操作面。

## Scope

- In scope: Claude/Codex/Grok 模型桥接，Claude/Codex/Cursor/Grok 官方登录与状态，中文 UX，Fold8 验证。
- Out of scope: 导出 OAuth/订阅令牌；把任意模型伪装成 Cursor 账号；未验证协议的跨厂商转译。

## Facts and constraints

- Product facts: Standard/Power 共用 CLI 层；CLI 运行在 App 私有 Alpine。
- Technical constraints: 密钥不得进入命令、导航、日志或配置文件；Codex 自定义 provider 仅走 Responses wire API。
- Accessibility / localization constraints: 48dp 触控目标、TalkBack、简繁英同步、200% 字体与 Fold8 双尺寸。

## References

- Product references: 现有 SettingsSection、CLI 卡片、模型选择器与终端启动提示。
- Visual references: Android Material 3 设置层级与聊天模型选择器的“本机 CLI”分组。
- What to inherit from each reference: 语义色、圆角、主次按钮、状态徽标、中文密度。
- What must not be copied: Mac Web 控制台、iOS 表单外观、第三方 CLI TUI。

## Assumptions and open decisions

- Assumptions: 默认优先复用 LeoPhoneAgent 已配模型；官方订阅能力仍走 CLI 自己登录。
- Open decisions: 兼容端点失败时不静默回退，显示原因并提供一键切换官方账号。
