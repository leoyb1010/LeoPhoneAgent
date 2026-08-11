# leocodebox 1.40.5

## 本次升级

- 修复全新 Mac 的 CLI 发现契约，隔离测试覆盖 Claude、Codex、OpenCode、Cursor、Gemini、Hermes、Grok。
- 正式包内置 Playwright headless Chromium；运行环境修复只写入用户目录，不再修改已签名 `.app`。
- Browser MCP 凭据改为 `0600` 文件传递，不再暴露在进程命令行。
- macOS 红色关闭按钮现在真正退出并停止 38473；首次启动会安全停用冲突的旧 CloudCLI LaunchAgent 并保留备份。
- 从 App 打开浏览器改为两分钟、单次有效授权链接；修复授权完成前插件和任务请求产生 401 的竞态。
- 设置入口统一到完整设置中心；Agent 标签支持窄窗口横向滚动。
- Leoapi 备份列表补充 Agent、文件名、目标路径、时间和大小，恢复确认明确显示替换目标。
- 清理 5 个源码冲突副本；打包阶段还会自动清除依赖目录中的 Finder/iCloud 冲突副本，端口示例统一为 38473。
- 主工作台、启动页、关于页、Leoapi 与 DMG 融合经审查合格的视觉资产；未使用带烘焙棋盘格的错误透明素材。

## 验证

- ESLint 0 警告，客户端与服务端 TypeScript 检查通过，生产构建通过。
- 自动测试：desktop 24、client 40、server 190，共 254 项通过。
- 全新设备隔离测试通过；生产依赖安全审计 0 漏洞。
- 打包后 App 在全新 HOME 下完成 SQLite ABI、七类 CLI、免登录、Browser Session 和关闭释放端口测试。
- 一次性浏览器授权首次交换 200、重复交换 403。
- 浅色、深色、1152px 设置页和 Leoapi 已完成截图复审。

## 下载校验

- DMG SHA-256：`08523f27e520ff48afc1cc2be0bef2877556d8cf72e9a2a655660b2c57eaa58b`
- ZIP SHA-256：`ac804ebc802cdec74a82f9cdf9a8c7eb58acda5ed29b76b7c47ea6c6c77b0eb4`
- `latest-mac.yml` SHA-256：`3209c687ea0b8dd33a30ff706d78b0b65d694f3aa2ff35dbadbef261025c85aa`
