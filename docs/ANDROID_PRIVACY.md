# LeoPhoneAgent Android Privacy / Android 隐私说明

Last updated: 2026-08-31

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

### Remote control of this phone (inbound)

Since alpha.7 the Android app can also act as a *body*: another machine in your
fleet can drive the agent that runs on this phone. This is off by default and is
controlled by a single switch — Fleet → "Allow this phone to accept remote
tasks". It only works after you have saved your own Relay address and key; there
is no Leo-operated control plane.

While that switch is on:

* A persistent foreground-service notification ("Remote body online") is shown
  the whole time the phone is reachable. There is no silent mode — if the
  notification is gone, the phone is not accepting remote tasks.
* Remote turns run through the same on-device agent, the same provider
  credentials and the same tool permissions as a chat you start yourself.
  Prompts and attachments still go only to your configured AI provider.
* Privacy tools (contacts, location, photos, calendar, clipboard) are forced to
  "ask once" for as long as the switch is on, even if you had set them to
  "bypass" for local use. A remote caller therefore cannot read that data
  without a confirmation on this phone, and a request that nobody answers is
  denied rather than left pending.
* `android-open` refuses `intent:` / `android-app:` URIs that name an explicit
  component, so text the agent picked up from a web page cannot be used to
  launch arbitrary activities on this phone.
* Accessibility and Shizuku execution tools stay unavailable to remote callers
  unless you enabled them yourself; unregistered tools fail closed.
* Turning the switch off stops the connection, drops the persistent
  notification and cancels the background keep-alive work.

Standard edition does not register Accessibility or Shizuku execution tools.
Power edition exposes them only after both the Android system authorization and
the in-app Agent permission are granted. Accessibility events are captured only
during an explicitly approved watch request; password-field events are ignored.
Privileged destructive commands require confirmation for each call.

### Developer CLIs

Android alpha.9 can download and run Claude Code, Codex CLI, Grok Build and
Cursor CLI inside the app-private Alpine Linux sandbox. Each install is an
explicit user action and uses a fixed official HTTPS source. Those CLIs send
prompts, source files and tool results to their own providers under the
provider's terms. A CLI's own login may persist its login files inside the
private Linux rootfs; those third-party files are app-private but are not
stored in LeoPhoneAgent's Android Keystore preferences.

If you explicitly enable “Use LeoPhoneAgent's current API key”, only a matching
Anthropic/OpenAI/xAI API key is handed to that one terminal child process in
memory. The key is not placed in a navigation route, command line, shell
history or Linux config file. OAuth/subscription tokens, custom endpoints and
Azure credentials are never exported to an external CLI. Cursor uses its own
login or `CURSOR_API_KEY`.

You can delete conversations, provider credentials, memories, mounted folders,
logs and application data from the app or Android system settings. Uninstalling
the app removes its private local data.

### Treasury / local knowledge library

Treasury items, extracted text, reading progress, highlights and annotations
are stored in the app-private local database and files. Saving an original URL,
text or file does not require OCR, a model or a Leo-operated server. PDF text
extraction runs locally in bounded WorkManager jobs; unsupported OCR or audio
transcription remains visibly partial instead of uploading the file silently.
External web, PDF, OCR and transcription text is treated as untrusted content
and cannot authorize `treasury_save` or `treasury_update`. Content is sent to an
AI provider only when you explicitly include or ask the Agent to use it. A
Treasury write also requires an approved tool call and an explicit request in
the current real user message; negative or prompt-injected text fails closed. When
you configure your Leo Relay, Treasury metadata is synchronized incrementally;
body text and attachments are transferred only after an explicit remote request
or an offline-body choice. Transfers are size-bounded and verify SHA-256, byte
count and MIME. Disabling/removing the Relay configuration stops future remote
synchronization; existing device-local and already cached copies remain until
you delete app data or the corresponding Treasury content.

---

LeoPhoneAgent 是一个个人、本地优先的 Agent。聊天会话、终端文件、设置、权限决定和
Relay 配置保存在 Android 设备上，并已禁用 Android 云备份。API Key、OAuth Token、
环境变量和 Relay Bearer Token 使用 Android Keystore 支持的加密存储；如果安全存储
无法创建，凭据只保留在当前进程内存中，重启后需重新输入。

配置 AI 提供商后，提示词和你选择的附件会直接发送到该提供商端点，并受其隐私条款
约束；LeoPhoneAgent 不会通过 Leo 运营的云端中转这些流量。你自行配置的 Leo Relay
会通过 HTTPS/Tailscale 向选中的 Mac 发送已认证请求。应用不包含广告或分析 SDK；
崩溃日志默认只保留在本机，除非你主动分享。

### 本机被远程控制（入站方向）

自 alpha.7 起，Android 端也可以作为「身体」：舰队里的另一台机器可以驱动本机上
运行的 Agent。该能力默认关闭，由一个开关控制 —— 舰队 →「允许本机接受远程任务」。
它只在你保存了自己的 Relay 地址与密钥之后才生效，不存在由 Leo 运营的控制面。

开关打开期间：

* 只要本机处于可被下发任务的状态，就会常驻一条前台服务通知（「远程身体在线」）。
  没有静默模式 —— 通知不在，就说明本机不接受远程任务。
* 远程任务走的是同一个本地 Agent、同一份提供商凭据、同一套工具权限，
  与你自己发起的会话完全一致；提示词与附件仍然只发往你配置的 AI 提供商。
* 隐私类工具（通讯录、定位、相册、日历、剪贴板）在开关打开期间被强制提升为
  「每次询问」，即使你为本地使用把它们设成了「直接放行」。因此远程调用方无法
  在本机没有确认的情况下读走这些数据；无人应答的请求按拒绝处理，而不是一直挂着。
* `android-open` 会拒绝内联了显式 component 的 `intent:` / `android-app:` URI，
  因此 Agent 从网页等外部内容里抓回来的文本无法被用来拉起本机上的任意组件。
* 无障碍与 Shizuku 执行工具对远程调用方同样不可用，除非你自己开启过；
  未注册的工具一律 fail-closed。
* 关闭开关会断开连接、撤下常驻通知，并取消后台保活任务。

Standard 版不注册无障碍或 Shizuku 执行工具。Power 版只在 Android 系统授权和应用内
Agent 权限都通过后才可调用。无障碍事件只在你明确批准的监听请求期间采集，密码
字段事件会被忽略；高权限破坏性命令每次调用都需确认。

### 开发 CLI

Android alpha.9 可以在应用私有的 Alpine Linux 沙箱中下载并运行 Claude Code、
Codex CLI、Grok Build 和 Cursor CLI。每次安装都由用户明确发起，并只使用固定的
官方 HTTPS 来源。这些 CLI 会按照各自提供商的条款发送提示词、源文件和工具结果。
CLI 自己的登录可能把登录文件保存在私有 Linux rootfs 内；这些第三方文件属于应用
私有数据，但不使用 LeoPhoneAgent 的 Android Keystore 加密偏好存储。

只有当你明确打开「使用 LeoPhoneAgent 当前 API Key」时，匹配的 Anthropic、OpenAI
或 xAI API Key 才会通过内存交给当前这一个终端子进程。密钥不会进入导航参数、
命令行、Shell 历史或 Linux 配置文件。OAuth/订阅令牌、自定义地址和 Azure 凭据
不会导出给外部 CLI；Cursor 使用自己的登录或 `CURSOR_API_KEY`。

### 藏宝阁 / 本地知识库

藏宝阁条目、提取正文、阅读进度、高亮和批注保存在应用私有数据库与文件中。保存原始
URL、文字或文件不依赖 OCR、模型或 Leo 运营的服务器。PDF 文本只在有边界的
WorkManager 后台任务中本地提取；不支持的 OCR 或音频转写会明确显示 partial，不会
静默上传文件。网页、PDF、OCR 和转写文本都按不可信资料处理，不能授权
`treasury_save` 或 `treasury_update`。藏宝阁写操作还必须经过工具审批，并在当前真实用户
消息中存在明确请求；否定表达或提示注入文本会拒绝执行。只有你明确选择或要求 Agent 使用时，相关内容才会
发送给已配置的 AI 提供商。配置自己的 Leo Relay 后，藏宝阁元数据使用游标增量同步；
正文和附件只有在远端明确请求或用户选择离线正文时才传输，并校验大小、SHA-256、
byte count 与 MIME。删除/停用 Relay 配置会停止后续远端同步；设备本机和已经缓存的副本
会保留到用户删除相应收藏或应用数据。
