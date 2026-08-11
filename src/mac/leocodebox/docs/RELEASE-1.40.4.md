# leocodebox 1.40.4

## 这一版你多了什么

- **Leoapi 在应用内成为最终权威**：会话启动时注入当前启用接口的环境覆盖层（Claude 与 Codex）。此前若机器的 shell 环境里存在 ANTHROPIC_*/OPENAI_* 导出（例如 cc-switch 或手工 rc 配置留下的），进程环境变量会压过 Leoapi 写入的配置文件——切换看似成功，会话仍走旧接口。现在只要 Leoapi 有启用的接口，应用内会话一定走它；未启用任何接口时，机器原有配置（含 shell 导出）继续生效，即「本机原配置」语义不变。
- **shell 覆盖可见**：检测到 shell 环境变量与当前启用接口不一致时，目标页头部明确警示「终端会话会优先走 shell 变量；应用内会话由 Leoapi 接管」——不再有看不见的优先级。
- **模型下拉回归修复**：聚焦即显示全部模型（此前输入框里已有模型名时会按整个值过滤，看起来"没有选项"），输入时才过滤。

## 验证

- 服务端 189 项、前端 40 项测试全部通过；TypeScript、ESLint（0 警告）、生产构建通过。
- macOS App 使用 Developer ID 签名并完成 Apple 公证与装订。

## 下载校验

- DMG SHA-256：`a8eda70b7f44bdd86347e92c3e849143fa28143781b96de42f468085d4da4fb7`
- ZIP SHA-256：`9efd37df775d426fe5eeed3b04b9c305cf2d7bc874f7031e2458033febfe7c54`
- `latest-mac.yml` SHA-256：`d76ed43801d72c45f8c6cead15b9b1e245436046e384b82558bb240288807065`
