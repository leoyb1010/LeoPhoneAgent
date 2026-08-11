# leocodebox（简体中文）

完整的项目说明（特性、架构、构建、签名公证）请见 **[README.md](README.md)** —— 主 README 即为简体中文。

## 一句话简介

本地优先的 macOS 桌面应用，在一个界面里统一管理本机的 AI 编码 Agent CLI（Claude Code、Codex、Cursor、OpenCode、Gemini CLI、Hermes、Grok Build），以及项目、会话、Skills、MCP 和 Provider 配置。无需注册、无需云端账号。

## 本地模式

- 服务默认只绑定 `127.0.0.1:38473`，打开自动启动、退出自动停止。
- 桌面壳向自己的本地 WebView 注入一次性本地能力 token。
- leocodebox 云账号和托管 Agent 环境在本构建中关闭。
- 每台设备会从登录 Shell 和常见包管理器路径发现本机 Agent CLI，并识别各 CLI 的自定义配置目录。
- 应用内更新可选启用；Private Release Token 由 macOS 钥匙串加密保存。

## 许可证与声明

leocodebox 以 **AGPL-3.0-or-later** 分发；基于 CloudCLI UI（`https://github.com/siteboon/claudecodeui`），保留 `LICENSE` 与 `NOTICE` 中要求的第三方声明。
