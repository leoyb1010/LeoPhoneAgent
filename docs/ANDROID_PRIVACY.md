# LeoPhoneAgent Android Privacy / Android 隐私说明

Last updated: 2026-08-16

LeoPhoneAgent is a personal, local-first Agent. Chat sessions, terminal files,
settings, permission decisions and Relay configuration are stored on the
Android device. Android cloud backup is disabled. API keys, OAuth tokens,
environment variables and Relay bearer tokens use Android Keystore-backed
encrypted preferences; if secure storage cannot be created, credentials remain
memory-only and must be entered again after restart.

When you configure an AI provider, prompts and selected attachments are sent
directly to that provider's endpoint under its own privacy terms. LeoPhoneAgent
does not proxy that traffic through a Leo-operated cloud. A user-configured Leo
Relay sends authenticated requests to the selected Mac over HTTPS/Tailscale.
The app does not include advertising or analytics SDKs. Crash logs remain local
unless you explicitly share them.

Standard edition does not register Accessibility or Shizuku execution tools.
Power edition exposes them only after both the Android system authorization and
the in-app Agent permission are granted. Accessibility events are captured only
during an explicitly approved watch request; password-field events are ignored.
Privileged destructive commands require confirmation for each call.

You can delete conversations, provider credentials, memories, mounted folders,
logs and application data from the app or Android system settings. Uninstalling
the app removes its private local data.

---

LeoPhoneAgent 是一个个人、本地优先的 Agent。聊天会话、终端文件、设置、权限决定和
Relay 配置保存在 Android 设备上，并已禁用 Android 云备份。API Key、OAuth Token、
环境变量和 Relay Bearer Token 使用 Android Keystore 支持的加密存储；如果安全存储
无法创建，凭据只保留在当前进程内存中，重启后需重新输入。

配置 AI 提供商后，提示词和你选择的附件会直接发送到该提供商端点，并受其隐私条款
约束；LeoPhoneAgent 不会通过 Leo 运营的云端中转这些流量。你自行配置的 Leo Relay
会通过 HTTPS/Tailscale 向选中的 Mac 发送已认证请求。应用不包含广告或分析 SDK；
崩溃日志默认只保留在本机，除非你主动分享。

Standard 版不注册无障碍或 Shizuku 执行工具。Power 版只在 Android 系统授权和应用内
Agent 权限都通过后才可调用。无障碍事件只在你明确批准的监听请求期间采集，密码
字段事件会被忽略；高权限破坏性命令每次调用都需确认。
