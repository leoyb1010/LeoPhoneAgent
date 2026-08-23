# UI Proof

## Verification scope

- Release level: Android `1.0.0-alpha.13` Standard + Power Release APK.
- Routes / screens: 设置 → 开发 CLI；连接与模型对话框；全屏终端；官方授权页；本次更新弹窗。
- Viewports / devices: Fold8 API 35，1768×2208 展开态与 1080×1728 封面态。
- Browsers / simulators: Android Emulator 37.1.11；WebView 124；真实 PRoot Alpine ARM64 CLI。

## Evidence

- Screenshots / visual diffs: 展开态 alpha.13 中文更新弹窗、Claude/Grok 终端、Codex/Cursor 授权页；封面态 CLI 卡片和 Grok 配置对话框均完成截图检查。
- Storybook stories and tests: N/A（原生 Compose）；Standard/Power JVM 完整测试均 0 失败。
- End-to-end interactions: alpha.12 → alpha.13 双包覆盖 `Success`；Claude Leo 模式直达目录信任；Grok Leo 模式显示 `Logged in with API key`；Codex/Cursor/Grok 登录链接自动打开。
- Accessibility checks: UIAutomator 树确认所有主操作有中文文本/内容描述；按钮保持 Material 48dp 触控目标。
- Console / network checks: 官方 auth host 严格 HTTPS 白名单回归测试；Logcat 无本 App `FATAL EXCEPTION`；密钥未出现在托管配置。
- Performance checks: Standard 冷启动 587ms / Assist 556ms；Power 启动 781ms / Assist 517ms。
- Reduced-motion check: 新界面不依赖动画传达状态；CLI 启动遮罩硬上限 3 秒。

## Originality gate

Use for net-new or overhauled work. Maintenance inside an established system may mark this `N/A`.

| Axis | Score (0-2) | Rendered evidence |
|---|---:|---|
| Product specificity | 2 | 同卡表达官方账号与 Leo 模型两条真实路径 |
| Hierarchy | 2 | 安装/连接状态 → 启动主操作 → 登录次操作 |
| Composition | 2 | Fold8 展开/封面态均无水平溢出 |
| Material and assets | 1 | 延续原生 Material 3，无新图片负担 |
| Typography and color | 2 | 状态色仅用于成功/错误/选中，中文长文案可读 |
| Interaction and motion | 2 | 授权链接自动打开，遮罩不再占用交互 |
| Feasibility | 2 | 四个真实 CLI 安装与链路验证 |
| **Total** | **13/14** | 通过 11/14 门槛，无零分 |

- Threshold: 11/14, no zero, product specificity = 2, hierarchy = 2.
- Category-interchangeable regions still visible: 安装卡的 Material 列表外壳沿用项目既有系统。
- Direction correction required, if any: 无；本轮是已有设置表面的产品化重构。

## Snapshot decisions

- Intentional baseline changes: 「使用 LeoPhoneAgent API Key」单开关替换为「CLI 官方账号 / Leo 模型」；安装后显示真实 auth 状态。
- Rejected changes: 导出 OAuth/订阅令牌；伪造 Cursor 自定义 provider；对任意终端 URL 自动打开。

## Remaining risk

- Known issues: xAI device-code 页在模拟器 WebView 124 返回标题但页体为空，日志指向第三方页脚本/WebRTC 能力；授权 URL 与 code 已正确传入，预览菜单保留系统浏览器退路。
- Deferred work: 真实 Fold8 的 xAI 账号完整 OAuth 回调需用户本人凭据，本轮不代登。
- Visual verification outstanding: 无代码内 UI 阻断项。
