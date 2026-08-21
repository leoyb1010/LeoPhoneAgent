# LeoPhoneAgent 更新记录

版本号遵循 `主版本.次版本.补丁版本`。1.0 系列的每次常规更新依次递增为
`1.0.1`、`1.0.2`、`1.0.3`……`1.0.12`，同时递增 iOS 构建号。1.1.0
开发期只递增内部 Build，完成全部验收后一次正式发布。

## HarmonyOS 0.3.0-alpha.14 (100019) - 2026-08-20

- Kimi 登录直接打开带设备码的确认页，登录后不用再手抄顶栏那串码。
- 覆盖安装必须弹出「本次更新 · Kimi 确认页带设备码」。

### 验证

- `bash src/harmony/scripts/verify_harmony_release_notes.sh`
- `node --test src/harmony/protocol/protocol.test.mjs`

## HarmonyOS 0.3.0-alpha.13 (100018) - 2026-08-20

- Kimi 设备码登录直接打开确认页，不再先停在空白再超时。打不开时仍显示设备码，可复制链接。
- 覆盖安装必须弹出「本次更新 · Kimi 确认页能打开」。

### 验证

- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.12 (100017) - 2026-08-20

- 供应商详情里「从上游拉取」和「用作当前」不再被长模型列表顶出屏幕。切换供应商先点名字再展开模型。
- 覆盖安装必须弹出「本次更新 · 详情页能拉到按钮」。

### 验证

- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.11 (100016) - 2026-08-20

- 本机对话吐字时，列表跟着滚到最新一句，不用再手滑下去看。
- 覆盖安装必须弹出「本次更新 · 吐字跟着滚」。

### 验证

- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.10 (100015) - 2026-08-20

- 登录页停在空白时不再当成已经打开。八秒后出现「页面打不开」和复制链接，不跳系统浏览器。
- 覆盖安装必须弹出「本次更新 · 登录打不开会说明」。

### 验证

- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.9 (100014) - 2026-08-20

- 设置、会话、说话、识图、朗读不再用单个汉字当图标，改成系统图标。
- 本机对话按帧往气泡上刷字。供应商没配完也能点切换。
- 覆盖安装必须弹出「本次更新 · 图标和逐字回复」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.8 (100013) - 2026-08-20

- 竖屏不再按内屏宽度强行左右分栏。会话改成卡片，设置分区改成中文。
- 对话气泡不再切掉左边的字，发送键不再挤成省略号。供应商详情的模型列表可点选，保存钉在底部。
- 覆盖安装必须弹出「本次更新 · 排版不再切字」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.7 (100012) - 2026-08-20

- 在详情页换完模型回到首页，「选择执行模型」会显示刚选的那个，不再停在上一份名字。
- 覆盖安装必须弹出「本次更新 · 当前模型会跟着变」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.6 (100011) - 2026-08-20

- 加完供应商回到首页，「选择执行模型」会解锁，点进去就能换当前模型。
- 登录授权不再跳系统浏览器。打不开就停在本页中文说明并可复制链接。
- 覆盖安装必须弹出「本次更新 · 选模型能点进去」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.5 (100010) - 2026-08-20

- OpenAI 登录被地区拦截时，不再把 403 JSON 和「美观输出」铺满屏幕。改成中文说明，并给出复制链接、系统浏览器。
- 登录页一打开就提示需要境外网络。8 秒打不开也会收掉网页。
- 覆盖安装必须弹出「本次更新 · 登录页不再白屏」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.4 (100009) - 2026-08-20

- 添加供应商保存后进入详情页选模型，新实例自动设为当前。本机聊天顶栏可切换供应商和模型。
- OAuth 登录页打不开会写出错误，可复制链接或用系统浏览器。OpenAI / Claude / xAI / Gemini 会提示需要境外网络。
- 冷启动后本机引擎先加载供应商档案，当身体和定时任务不再误报「还没配供应商」。
- 定时任务结果写入「定时·标题」会话，失败原因留在定时页；失败当天不标记已跑。仅前台执行。
- Anthropic / Kimi / xAI OAuth 会存 refresh token。拉模型按类型带认证头，失败时走 models.dev / 内置列表。
- 覆盖安装必须弹出「本次更新 · 供应商贯通」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.3 (100008) - 2026-08-20

- OpenAI OAuth 登录后本机对话走 `chatgpt.com/backend-api/codex/responses`，和 Fold8 同一条后端。
- 刷新 token、账号头、Responses 工具调用都接上。覆盖安装必须弹出「本次更新 · Codex 能聊」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.2 (100007) - 2026-08-20

- 添加供应商按 Fold8 列出这一家真能用的登录：OpenAI / Anthropic / OpenRouter 有 OAuth，Kimi / xAI 设备码排前面，Gemini 只有 API Key。
- 点 OAuth 在本页打开登录网页，拦 localhost 回调换 token；不再灰一行「设备码」，打开网页也不会把轮询取消。
- OpenAI Codex 登录后本机对话仍走 Chat Completions；Codex Responses 后端这一版还没接。
- 覆盖安装必须弹出「本次更新 · 供应商 OAuth」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.1 (100006) - 2026-08-20

- 鸿蒙当身体：向中继注册 `platform=harmony` / `server=minis`，iPhone 可开会话并走本机工具循环。
- 本机补齐：Kimi/xAI 设备码、语音说/读、Push Kit 要 token、Markdown、识图落盘、模型组失败换、用量 token、浏览器标签、HTTP MCP、前台定时。
- 鸿蒙 NEXT 跑不了 Android 那份 PRoot。Push 没配 AGC 时杀进程后仍收不到。
- 覆盖安装必须弹出「本次更新 · 鸿蒙当身体」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.2.0-alpha.3 (100005) - 2026-08-20

- 本机对话走工具循环：file_list / file_read / file_write / file_edit / memory_write / memory_get / open_url / web_fetch。
- 写文件仍默认询问。没有 Linux 命令，也不做无障碍跨应用。
- 覆盖安装必须弹出「本次更新 · 本机工具循环」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.2.0-alpha.2 (100004) - 2026-08-19

- 供应商按 Fold8：类型 → 凭证 → 身份/接口，多实例、拉 /models、模型组。
- 外观跟随系统或锁浅色 / 深色，状态栏一起变；启动会话、回车发送、常亮可配。
- 设置分区对齐 Fold8：远程机器、中继、Soul、环境变量、用量。
- 覆盖安装必须弹出「本次更新 · 供应商和深浅色对齐 Fold8」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.2.0-alpha.1 (100003) - 2026-08-19

- 本机 Agent：OpenAI 兼容对话、会话落盘/搜索/置顶/日期分组、长按归档删除、记忆、技能、藏宝阁、沙箱文件、应用内打开链接。
- Pura X Max 内屏按 Fold8：左栏自带 Leo 顶栏，会话行 44 图标 + 13 相对时间，左右 56 新任务/搜索，气泡 80%。
- 写沙箱文件默认询问。没有 Linux 沙箱，也不做无障碍跨应用。
- 覆盖安装必须弹出「本次更新 · 本机 Agent 对齐 Fold8」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## Android v1.0.0-alpha.10 - 2026-08-21

### 开发 CLI 使用体验重做（对话可达性 P0 的第一步）

- 「打开终端」改为「启动」：命令**立即自动执行**，不再把裸命令留在黑屏提示符上等用户自己发现要按回车；启动期间显示中文进度提示（首次约 30–60 秒 + 唤起键盘指引），CLI 开始输出或切入 TUI 后自动消失。
- 安装成功弹窗新增「启动」主按钮：装完 → 一键进入工具，入口深度从 4 层降为 0。
- 终端快捷键栏新增「粘贴」键：OAuth 授权码可直接粘贴进 CLI 登录流程（此前只能长按选区，不可发现）。
- 安装过程日志可见：进行中可展开完整滚动日志；失败弹窗显示安装器完整输出，支持「复制日志」与「一键重试」——不再只有 180 字符截尾。
- CLI 卡片层级重排：已安装 =「启动」（填充主按钮）+「更新」（描边次按钮）+ 溢出菜单（模型与授权 / 更新 / 卸载）；未安装 = 单一「安装」主按钮。
- 新增卸载：只删启动器本体，保留登录态与配置文件，重装免再登录。
- CLI 状态检测从四次串行 proot 往返合并为**单趟探测**（`___LEO_CLI___` 标记逐工具带真实退出码），进页明显更快；探测失败保留上次状态，不出假红。
- Cursor 安装超时上调至 20 分钟（源码重建原生模块在低端机可能超过统一的 10 分钟上限）。

### 装机后「本次更新」提示（发版铁律第一条，Android 首次落地）

- 每次覆盖升级后首启弹出「本次更新」对话框，内容即本版真实变更（简体/繁体/英文）；从无此机制的旧版（≤ alpha.9）升级上来通过安装时间戳识别，同样会弹出。

### 内部质量

- 安装/卸载结果改为 sealed 模型（成功/失败/已卸载），不再用一个字符串字段按布尔翻转语义。
- `launchCommand` 支持受限工作目录参数（仅 `/root`、`/var/minis/**`，拒绝穿越与控制字符，完整 shell quoting）——为下一版「在挂载文件夹中启动」铺路。
- 新增定向测试：状态标记解析（真实退出码、缺行补齐、垃圾行容错）、卸载命令边界（禁止 rm -rf、保留登录）、工作目录白名单与引号转义、超时分级、失败日志拼装、What's New 资源门禁。

### 验证

- Standard/Power JVM 测试各 516 项，0 失败（含新增 9 项定向测试）；中文资源门禁通过；双 Release lint 0 error；`--max-workers=1` 双 flavor 构建通过；固定个人 Alpha 签名校验通过。
- Fold8 API 35 展开态实机：alpha.9 → alpha.10 双 flavor 覆盖安装 `Success`；升级首启弹出中文「本次更新」；完整闭环实测——装 rootfs → 装 Claude Code 2.1.238（滚动日志可见）→ 成功弹窗点「启动」→ 终端自动执行 → 启动提示自动消失 → 快捷键栏含「粘贴」；Standard `ACTION_ASSIST` 冷启动、Power 冷启动均 `mCurrentFocus` 正确；全程 Logcat `FATAL EXCEPTION` 0 条。
- 发布链修复：干净 worktree 首次构建缺 `assets/alpine-minirootfs.tar.gz` 与 `proot-aarch64`（构建期资产，不入库），装机后 rootfs 安装报 `Installation failed`——已按 `scripts/prepare_android_sandbox.sh` 固定 SHA-256 重新供应并重建，最终 APK 已含全部沙箱资产并复验。

## Android v1.0.0-alpha.9 - 2026-08-21

### 本机开发 CLI

- 设置新增「开发 CLI」，可在 App 私有 Alpine ARM64 沙箱中安装、更新、检测并打开 Claude Code、Codex CLI、Grok Build 和 Cursor CLI。
- 四个安装入口只允许固定官方 HTTPS 地址；安装脚本限制协议、跳转协议、连接时间和最大体积。Cursor 所需 `node-addon-api 8.9.2` 固定 SHA-512 后才解包。
- 每个 CLI 可设置模型 ID，打开终端时通过安全 shell quoting 传入 `--model`；超长和控制字符会被拒绝。
- 可选择使用 LeoPhoneAgent 当前、同供应商、API-Key 类型的模型授权：Anthropic → Claude、OpenAI → Codex、xAI → Grok。密钥只通过一次性内存交给新终端进程，不进入导航参数、命令行、Shell 历史或磁盘；OAuth、订阅令牌、自定义地址和 Azure 凭据拒绝导出。Cursor 继续使用自己的官方登录或 `CURSOR_API_KEY`。

### Alpine 兼容与更新安全

- 修复 Android 宿主 `TMPDIR=/data/user/...` 泄漏到 PRoot，导致 Codex 官方安装器 `mktemp -d` 静默失败；所有持久 Shell、一次性 Shell 和终端统一使用 guest `/tmp`。
- 状态探测不再用会吞掉前序错误码的管道；二进制存在但不能运行时显示「未安装」，不再假绿。
- Cursor 官方 Linux ARM64 包内含 glibc Node/原生模块。alpha.9 自动切换 Alpine Node、从源码重建模块，并对缺失的 GNU Merkle 绑定应用最小兼容层；已在 Fold8 API 35 上从 App 内真实更新并回读 `2026.08.11-e8db854`。
- Cursor 更新前由 Android 宿主原子备份整个 versions 目录；下载、重建、补丁或验证任一步失败都会恢复旧版本，成功才清理备份。

### 验证

- Fold8 API 35 的真实 Alpine ARM64：Claude Code `2.1.238`、Codex CLI `0.149.0`、Grok Build `1.0.5`、Cursor CLI `2026.08.11-e8db854`，四个严格版本命令退出码均为 0。
- 简体中文现场验证安装/更新/打开终端/模型与授权/确认弹窗全部为中文；Cursor 通过产品 UI 完成一次真实更新并显示「已经就绪」。
- Standard/Power 各 `507` 个 JVM 测试，0 失败（各 1 个既有跳过）；中文资源门禁、Standard Debug lint、双 Release lint 均为 0 error。
- Fold8 API 35 从 alpha.8 原地覆盖 alpha.9，Standard/Power 均 `Success`；普通冷启动与 `ACTION_ASSIST` 均 `Status: ok`，两进程存活且 AndroidRuntime 无崩溃。
- Standard SHA-256 `b88c9149cdf064da2d7fc6e41194847c40794209cd10b5454a99e72e39c127c4`；Power SHA-256 `a5497eab796960f4ed871c624283152e2b57b83c3fe630410477dce67465fc20`。

## Android v1.0.0-alpha.8 - 2026-08-21

### Fold8 与系统操控

- 完整合入 Android PR #3：Fold8 封面、展开、书本与桌面模式采用统一姿态策略，折叠切换时保留当前会话、草稿、滚动位置和输入法状态。
- 新增系统权限中心，集中展示默认助手、通知、电池优化、悬浮窗、通知访问、所有文件、精确闹钟和运行时权限，并为三星封面屏与休眠策略提供明确入口。
- 新增已安装应用枚举与按包名/应用名启动；`android-open` 继续经过产品权限闸门，并拒绝带显式 component 的危险 Intent。
- 聊天页对缺失的系统授权给出可操作提示；Fold8 大小屏布局、运动降级和关键触控目标补充回归测试。

### 编译与稳定性修复

- 修复 Relay 慢订阅压力测试低于 512 条生产缓冲、导致测试永远等不到 fail-closed 的问题；压力场景提升到 5000 条并真实覆盖溢出断流。
- 修正 `FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING` 的 API 守卫：仅 Android 14/API 34+ 传入该类型，Android 8–13 走兼容重载，避免旧系统拒绝启动远程身体常驻服务。
- Standard/Power 各 497 个 JVM 测试，0 失败（各 1 个既有跳过）；中文资源门禁、Standard Debug lint、双 Release lint 均通过（0 error）。
- Fold8 API 35 从 alpha.7 原地覆盖 alpha.8，Standard/Power 均返回 `Success`；普通冷启动与 `ACTION_ASSIST` 均为 `Status: ok`，两进程存活，AndroidRuntime 无崩溃。
- Standard SHA-256 `29b80c5b0a7d2263afad0594286d5336218545e033004c8bf947675a358f3b83`；Power SHA-256 `df96694e6efe7c1343f8c6b1ac7cb0ef7285664aa0d0d24f442606455769c3a5`。

## Android v1.0.0-alpha.7 - 2026-08-19

### 核心修复

- Android Relay Body 改为明确手动开启，默认只控制其他机器；关闭或清除密钥会立即终止旧 WebSocket。
- 修复 stop/steer 后旧 turn 继续回传终态、SSE 快照/实时接缝丢帧、慢订阅者静默丢帧和断线后旧 stream 泄漏。
- Android 主动上报审批/终态事件，断线期间有界缓存、重连后补发。
- Mac 工作台修复远程接管鉴权、事件字段、追问请求体、审批失败恢复和切换会话串状态；Android/Harmony 身体自动使用 `minis` harness。
- iOS 修复推理类型测试 target、Relay 地址/密钥串用和远程 Shell/Agent 绕过本地审批；非视觉模型不再假报已读图。
- Relay 拒绝日志改为 HMAC 指纹 + 限速 + 64KB 轮转；Native Offload 不再记录完整 argv/cwd；DOMPurify 升级至 3.4.13。

### 验证

- iOS MinisLogicTests `243/243`；Mac Client `137/137`、Server `354/354`，typecheck 与定向 eslint 通过。
- Android Standard/Power 各 `443` 个 JVM 测试，0 失败（各 1 个既有跳过）；Relay 并发与签名门禁继续通过。
- Fold8 API 35 从 alpha.6 原地覆盖 alpha.7，Standard/Power 均返回 `Success`；普通冷启动与 `ACTION_ASSIST` 均为 `Status: ok`，进程存活，Logcat 无本 App `FATAL EXCEPTION`。
- Standard SHA-256 `ff9257c23ce865e2edaf53bf02dd32fada9783ac7fbd0f46de1b51ef7aad44ba`；Power SHA-256 `89db6ec66fc7fd1bb2845bff23d653a28922b4b12a9d4466d4aab103ea617abb`。

## HarmonyOS 0.1.0-alpha.2 (100002) - 2026-08-19

- 做成完整远程控制面：产品图标、启动窗、深色界面，首页直接是远程机器而不是空架子。
- 适配 Pura X Max 阔折叠：外屏单栏，展开内屏左右分栏（舰队 + 新任务）。
- 中继钥匙、刷新、配对、新任务、续传、审批保留；本机 Agent / 鸿蒙身体仍未开，设置页写明。
- 覆盖安装必须弹出「本次更新 · Pura X Max 完整控制面」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.1.0-alpha.1 (100001) - 2026-08-19

- 首个鸿蒙瘦控制面：填中继钥匙后读 `/machines`，可对在线 Mac 或 Android 身体开新任务。
- 断线按 `?after=N` 续上；审批必须带 `approval_id`。配对码只含中继根和机器名。
- 首启弹出「本次更新」：鸿蒙瘦控制面。本机 Agent 与鸿蒙当身体未交付。

### 验证

- 协议层 `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs` 通过。
- `bash src/harmony/scripts/verify_harmony_release_notes.sh` 必须通过后才能装机。
- 本机 `hvigor assembleHap` 已通过，产物为未签名 `entry-default-unsigned.hap`（165K）。`hdc list targets` 为空，未做真机覆盖安装。

## iOS 1.24.0 (94) / macOS leocodebox 1.74.0 / Android 1.0.0-alpha.6 - 2026-08-19

- Android 可作为中继身体（`platform=android` / harness `minis`）；三端机器列表改读 `/machines`。
- 配对码只含中继根和机器名；iPhone 可扫码加入。APNs 在主机出现时重登记。
- 推理规则可编辑、换模型夹档可见；Android 身体的远程任务会带走当前档，Mac CLI 暂用各自默认档。压缩/标题便宜模型、压缩开关。非视觉模型不再假报已读图。
- 写文件/终端默认询问。会话可归档、分组、导入 JSON。系列用语：新任务 / 本机 / 远程 / 进行中 / 审批。
- Android 流式首包超时 30s → 120s。iOS OpenAI/Anthropic 请求超时已是 600s，未改。
- 供应商 JSON 读失败时拒绝再保存，避免空配置覆盖原文件。

### Android 发布前修复

- 移除 `StateFlow.distinctUntilChanged()` 无效操作；Kotlin 在双 flavor 中把该过时用法判为编译错误。
- minis harness 会话事件回放改为锁内快照、锁外发射，修复异步写入时遍历可变列表引发的 `ConcurrentModificationException`。

### 验证（Android 发布机）

- iOS 源码与版本门禁字段已对齐 1.24.0 / 94，并写了本次更新条目。
- Standard/Power 中文资源门禁、各 440 个 JVM 测试（0 失败、各 1 个既有跳过）、双 Release lint（`0 errors`）和 R8 构建全部通过。
- APK 包名、versionCode `100006`、versionName、v2 签名与固定 Alpha 证书指纹均通过 `verify_android_alpha_release.sh`。
- Fold8 API 35 从 GitHub alpha.5 原地升级 alpha.6，Standard/Power 均返回 `Success`；展开几何下普通入口与 `ACTION_ASSIST` 冷启动、`1080×1728` 封面几何冷启动均为 `Status: ok`，进程存活，Logcat 无本 App `FATAL EXCEPTION`。

## macOS leocodebox 1.69.0 - 2026-08-18

### 额度改成问官方要,不再靠猜

- 吸收 CodexBar 的抓取能力:此前被动扫本机日志尾部、等服务端偶然下发额度帧(可能是几小时前的旧数字),现在用本机已有登录态直接调官方接口拿当前额度。Codex(`chatgpt.com/backend-api/wham/usage`)与 Claude Code(`api.anthropic.com/api/oauth/usage`)已打通,实测 Codex 33%@7d、Claude 30%@5h + 24%@7d。
- Claude 凭据**钥匙串优先、文件兜底**,且每个来源用前先查 `expiresAt` —— 本机文件里的 token 已过期 13 天,直接用只会拿到 401。
- 不硬编码窗口白名单:以「有数值 utilization + 有可解析 resets_at」为真实窗口判据,自动滤掉 Anthropic 的内部代号窗口,将来新增窗口也能接住。Codex 窗口长度一律从 `limit_window_seconds` 算,不按 lane 位置假设。
- 面板按 CodexBar 卡片规格重做:310px 卡片、每窗口一行(标题 + 剩余百分比 + 重置倒计时 + 6px 进度条 + 配速),进度条上画出配速位置、50%/20% 警戒刻度与 7 天窗口的工作日刻度。
- 新增配速判断:超前/落后多少、还能撑多久、预计几点用光、多大风险;数据不足以下结论时返回空,不给看起来很确定的 0。
- 权威与估算落到数据结构(`source` 字段):接口数据标「权威」,日志回落标「本机统计」。Gemini/Cursor/Grok/OpenCode 各自写明缺哪一样凭据,不填 0、不编百分比。
- 凭据全程只读:不写回、不刷新、不落日志;测试断言序列化快照里不出现任何 access token。

### 发版更新提示:加自动闸门

- `npm run verify:release-notes` 挂进 `desktop:dist:mac:signed` 链首,版本号与更新说明对不上直接构建失败 —— 1.68.0 那次漏写、装上却弹不出更新的情况不会再发生。
- 缺条目时明说"本版本更新说明缺失",不再 fallback 到上一版内容冒充。
- 修正根 CLAUDE.md 里早已废弃的 `resources/release-notes` JSON 路径,并把「每次发版都必须弹出本次更新」升格为全端通用第一条铁律。

### 验证

- 全量测试 518 通过 / 0 失败(desktop 34 + client 112 + server 372)。
- 端到端实跑 `readAiQuota()`,两家均返回真实权威额度。

## macOS leocodebox 1.68.0 - 2026-08-18

### 工作台外壳重做:对话即首页

- 9 项侧边导航 + 双侧栏 + 仪表盘首页,换成「46px 标题栏 → 820px 指挥条 → 264px 会话列表 + 会话详情 → 30px 状态栏」的对话优先外壳;冷启动直接落在会话上。
- 删除 `DesktopAppRail`、仪表盘首页地位、Fleet 独立 Tab、快速任务独立 Tab、常驻项目树侧栏;项目树移入 ⌘K 唤起的抽屉(仍是同一个 Sidebar,功能未减)。停在已退役 Tab 的旧安装会一次性迁移到对话页。
- 指挥条是全局唯一的新任务入口:Agent、`@目标`、五档权限模式、推理强度,回车即建会话并发出第一条指令;目标忙碌时入队,不吞回车。四个芯片都是下拉菜单而非循环按钮 —— 每一档看得见、可直达,权限模式每档还带一行说明。推理强度在开会话前就能定。
- 底色改为纯色:设计稿的 `#f6f5f1` / `#121514` 实机铺开偏黄/偏绿,色相饱和度各收一档;同时移除外壳上那层 webp 噪点纹理,它正是"底色不纯"的来源。

### 远程会话接管

- 新增三条中继薄代理:远程建会话、SSE 事件流(`?after=N` 全量回放后转实时)、多回合驾驶与叫停。
- 前端按 seq 续传,断线重连补回放不丢不重;审批复用既有的舰队审批接口。leocodebox 不复制远程会话状态。

### 视觉

- `tokens.css` 换成设计稿两套色板(深 `#121514` / 浅 `#f6f5f1`,主色 `#56f0b8` / `#0f766e`),仍走现有 HSL semantic token 体系;新增 7 个工作台专属表面 token。动效全部响应 `prefers-reduced-motion`。
- 设置栏目一个没减,只重新归组(外观移入工作区、插件移入系统),弹窗改 1000×660。

### 状态栏:AI 额度与状态

- 状态栏新增额度计,点开显示本机 AI 用量。借 CodexBar 的思路(不登录任何一家、只读各家 CLI 落在本机的状态),但严格区分「服务端下发的真实额度」与「本机日志累加值」:Codex 从 rollout 日志读权威 `rate_limits`(已用百分比 / 窗口 / 重置时间 / 套餐 / 余额),Claude 只能给近 5 小时的滚动 token 数并标注「本机统计」,读不到就说读不到,不填 0 也不编百分比。
- 未吸收:CodexBar 覆盖的 69 家里,Cursor / Gemini / Copilot / Bedrock 等靠浏览器 cookie 与各家后台 API 取数;本机实测这几家都没有落额度数据,需要另建凭据采集层,本版不做。

### 修复

- 移除 `.leocodebox-app-shell > * { position: relative }`。这条规则会改写每个直接子元素的定位,导致 Leoapi 面板掉到状态栏下方、"打开完整网关设置"的模态掉进文档流、指挥条下拉与远程弹层被主区盖住。改由四个在流子元素各自声明层级,浮层用 fixed / portal;状态栏补上原本靠该规则白拿的 `relative`(体检气泡定位依赖它)。新增断言防止规则被加回。

### 验证

- 前后端 typecheck 全绿;改动文件 eslint `--max-warnings=0` 通过;客户端单测 24 项全过;`npm run build` 通过;`npm run desktop:dev` 实机跑通。
- **尚未签名、未公证、未发布**:本机只有 Apple Development 证书,发布需 Developer ID Application 证书与公证 profile(见 `src/mac/leocodebox/docs/SIGNING.md`)。

## Android v1.0.0-alpha.5 - 2026-08-17

### 紧急修复

- 修复 alpha.4 无法覆盖安装：alpha.4 Release 附件误用了不同调试证书，Android 现场返回 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`。alpha.5 恢复与 alpha.1–alpha.3 相同的个人 Alpha 签名链，可直接从 alpha.3 覆盖安装。
- 完整携带 alpha.4 的助手闪退修复：VoiceInteraction 不再抢占会话窗口，截图与系统入口异常会降级而不是崩溃主进程。
- 修正 README 中与 alpha.4 Release 附件不一致的 SHA-256，不再把未闭环的产物当成可安装版。

### 发布门禁

- 新增 Android Alpha APK 校验脚本，同时核对 Standard/Power 包名、versionCode、versionName、APK 签名有效性和预期证书指纹。
- 发布前必须在已安装 alpha.3 的 Fold8 模拟器上用 `adb install -r` 通过 Standard/Power 覆盖安装，并做冷启动闪退检查。
- README 新增面向 Codex、Cursor、Claude Code 等 Agent 的完整交接手册；同步增加仓库级 `AGENTS.md`，并修正 BUILDING/CONTRIBUTING/CLAUDE 中已过时或相互冲突的 Android 发布说明。

### 验证

- Standard / Power 中文资源门禁、JVM 测试、Release lint 和 R8 双包构建一次通过；lint `0 errors`。
- Fold8 API 35 模拟器从 alpha.3 原地升级 Standard / Power 均返回 `Success`，安装后为 versionCode `100005`。
- Standard / Power 普通冷启动与 `ACTION_ASSIST` 冷启动均为 `Status: ok`，进程存活，Logcat 无 `FATAL EXCEPTION`。

## Android v1.0.0-alpha.4 - 2026-08-16

### 闪退根因

- `LeoVoiceInteractionSession.onShow` 在未关闭会话 UI 时立刻 `startActivity` + `hide()`。系统在升级后探测 `VoiceInteractionService`、或长按 Home / `ACTION_ASSIST` 绑定时会创建会话窗口，和这次抢窗口叠在一起，把主进程打崩。桌面图标、磁贴、小组件、深链都走同一进程，所以表现为「一开就闪退」。
- 助手截图若是 Hardware Bitmap，`compress` 会抛错；ChatScreen 消费截图/包名时也没有兜底。

### 修复

- VoiceInteraction：`setUiEnabled(false)`，`onShow` / `onReady` / 截图保存全部包起来，失败只降级到已有聊天页，不再崩进程。
- 磁贴、小组件、`ACTION_ASSIST`、`minis://` 深链、通知动作、开机/时区全部进同一条 `SystemEntryParser` 路由。
- 进程被杀后，遗留非终态 Run 写成「等待用户继续」，对齐 iOS；用户点了横幅或通知「继续」才恢复，不会偷偷重跑。危险/跨应用操作仍走 Power 版逐次确认。

### 新增

- 桌面小组件改为任务状态面：空闲 / 执行中 / 已暂停 / 已完成 / 需要处理。点状态进对应会话。隐私模式不写标题正文。语音按钮只打开前台 App 再录音。
- 快捷设置：新对话磁贴修稳，并加语音磁贴。设置页仍是原来的一键请求添加。
- App Shortcuts：新对话 / 语音 / 上次会话（去掉写死的 Standard 包名，Power 也能用）。
- 通知按钮：继续 / 暂停 / 打开会话。
- WorkManager 在开机、时区变化、覆盖安装后补登记计划任务；前台服务通知带上同一套动作。
- 设置 → 系统权限收成「系统入口」：默认助手、磁贴、小组件、通知、电池、快捷方式、无障碍，Power 另加 Shizuku 状态。

### 刻意未做

- 通知气泡、画中画、Credential Manager / Passkey、配套设备、NFC、Health Connect、全屏 Intent：仍然没有产品价值。
- 没有新开假日历。Android 已有 `android-calendar` 工具，不在本版另接一套 CalendarContract UI。

### 验证

- 新增 `SystemEntryParserTest`、`AgentRunRecoveryTest`；保留 `AssistIntentsTest`。
- 中文资源门禁与设置页英文硬编码门禁通过。
- Standard / Power JVM 测试各 426，0 失败（各 1 个既有跳过）。双 flavor Debug APK 已 assemble 通过。
- 修掉 alpha.3 起就红的 Release lint：补 `DETECT_SCREEN_CAPTURE`、`AssistState` 标 API 29、磁贴在 API 34 以下仍走旧 `startActivityAndCollapse` 但不再被 lint 判死刑。快捷方式按 Standard / Power 包名拆开。Release APK 交给 CI；本版不伪造 SHA，也不假装已发 GitHub Release。

## Android v1.0.0-alpha.3 - 2026-08-16

### 新增

- 可替换系统数字助手：`ROLE_ASSISTANT` + `VoiceInteractionService` + `ACTION_ASSIST`。长按 Home / 助手手势打开新对话，并带上当前 App 包名与可选截图。
- 快捷设置磁贴：从状态栏下拉直接开新对话；设置页可一键请求添加。
- 桌面小组件：新建对话 / 语音对话，复用现有 `minis://action/` 深链。
- 设置 → 系统权限：默认助手、磁贴、小组件入口（此前该页未挂到设置）。
- 截屏/录屏提示（Android 14+）：聊天界面被系统截取时给出提示。
- 预测性返回：`enableOnBackInvokedCallback`。
- 原生库按 16KB 页大小对齐（`ANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES`）。

### 已有并保留

- 悬浮窗、Android 16 Live Updates / 状态胶囊、前台服务、忽略电池优化、精确闹钟、边到边、照片选择器、分屏/折叠双栏、应用内语言、分享入口。

### 刻意未做

- 通知气泡、画中画、Credential Manager / Passkey、配套设备、NFC、全屏 Intent、Health Connect：对单用户本机 Agent 没有真实产品价值，或会与现有悬浮窗/灵动岛抢表面。

### 验证

- 新增 `AssistIntentsTest` 6/6 通过；中文资源门禁通过；Standard/Power Release APK 已用 JDK 17 组装，`aapt` 复核 versionCode `100003`，双包均通过 APK Signature Scheme v2。

## Android v1.0.0-alpha.2 - 2026-08-16

### 修复

- xAI OAuth 改用官方 RFC 8628 设备码流程：App 显示短码、复制入口和 xAI 验证页，并在后台自动轮询完成登录。
- 不再依赖 Android 浏览器对 `127.0.0.1:56121` 的回调，避免授权页要求把 Grok Build 长码粘回客户端、但 App 没有输入口的死路。
- xAI 授权网址严格限制为 HTTPS `x.ai` 官方域名；用户码、设备码和 Token 不记入日志。

### 新增

- Android“我的 Mac”任务区新增 Codex、Claude Code、Cursor、Grok 四个快捷选择。
- leocodebox 远程 harness 新增 Cursor Agent，通过官方 `cursor-agent -p --output-format stream-json` 无头协议启动 Mac 端任务。

### 验证

- xAI 真实设备授权端点已验证返回短码、`accounts.x.ai` 完整验证链接、1800 秒有效期与 5 秒轮询间隔（证据全部脱敏）。
- `XAIDeviceFlowTest` 与 Kimi 设备码回归测试通过；Standard Debug Kotlin/Compose 编译通过。
- Cursor CLI 可执行文件与版本已检出；当 Mac 尚未登录 Cursor 时会明确返回需先执行 `cursor-agent login`，不会假报任务成功。
- Standard/Power Release APK 已在 JDK 17 下构建成功，版本号与包名已用 `aapt` 复核，两包均通过 APK Signature Scheme v2 签名校验。

## Android v1.0.0-alpha.1 - 2026-08-16

首个 LeoPhoneAgent Android 双版本个人 Alpha 交付。

### 新增

- Standard 与 Power 两个独立包，可同时安装、独立保存数据。
- 本机 Agent、模型服务商、Skills、MCP、Memory、PRoot Linux 沙箱、终端、浏览器、语音、计划任务和 Mac Relay/Fleet 协同。
- Power 版新增无障碍与 Shizuku 深度 Android 操控路径；危险 shell/破坏性操作逐次展示完整命令并确认。
- Fold8 宽折叠适配：封面单栏、展开双栏、跨尺寸草稿保留和 200% 字体布局。
- 简体中文设置、列表、功能按钮、弹窗、错误提示和主操作 TalkBack 标签。
- Android CI、中文资源门禁、设置页英文硬编码门禁、双版本 lint 与测试。

### 安全与隐私

- 凭据存储不再在 Keystore 异常时降级成明文；失败时只保留进程内临时数据。
- OAuth callback 仅监听 loopback，不记录 code/state，并强制校验 state。
- Debug RPC 仅 Debug 构建启用、仅监听 loopback，并要求每安装随机令牌。
- Release 关闭普通明文 HTTP 与系统备份；拆分并收紧 Alarm/Boot Receiver。
- 无障碍文字只在主动监听期间采集并忽略密码字段；分享内容增加数量与大小上限。
- APK 内置 GPL、第三方许可、隐私说明和源码提供说明；Alpine/PRoot 下载增加固定 SHA-256 校验。

### 验证与下载

- Standard/Power 各 401 个 JVM 测试，0 失败（各 1 个既有跳过）。
- Fold8 API 35 设备端 111 个测试，0 失败、0 跳过；双 Release lint 均为 0 error。
- 无令牌 Debug RPC 返回 401，合法令牌返回 200。
- 两个最终 Release APK 已覆盖安装并同时运行，无启动崩溃。
- [GitHub Release 与 APK](https://github.com/leoyb1010/LeoPhoneAgent/releases/tag/android-v1.0.0-alpha.1)
- [完整五轮审计与交付报告](docs/ANDROID_DELIVERY_1.0.0_ALPHA1.md)

### 已知边界

- 当前仅提供 ARM64 APK。
- 本次附件使用个人 Alpha 调试证书签名，不是正式商店证书链；切换正式签名版时可能需要先卸载 Alpha。
- 正式公开发行前仍需完成真实 Fold8 物理机长稳/功耗测试、数据库全版本升级 fixture、商店隐私表单和发行 keystore 托管。

## 1.1.2 - 2026-07-26

- 修复 1.1.1 只补齐语言目录、但没有覆盖部分动态控件真实渲染路径的问题。
- Token 数字不再由代码固定缩写为 `K/k/M`，改用当前 App Locale 的系统紧凑数字格式；简体中文显示完整数字或“万”，繁体中文显示完整数字或“萬”。
- 对话输入区上方的内置快捷任务使用稳定 ID 匹配本地化显示名；用户编辑过的内置任务和自定义任务继续显示用户原名。
- Token 用量摘要中的上下文、输入、输出、缓存和输出速度文字随语言变化，`Token` 术语保持不翻译。
- 设备偏好实测为 `appLanguage = zh-Hans`，确认问题来自动态字符串与硬编码格式器，而不是用户语言设置。

## 1.1.1 - 2026-07-26

- 版本统一更新为 1.1.1（24），作为 1.1.0 后的首个补丁版本。
- 使用 Xcode String Catalog 重新提取全部用户界面文本，补齐快捷任务、输入快捷操作、对话框按钮、任务状态、任务产出和设置页此前遗漏的本地化。
- 德语、法语、日语、韩语、俄语、简体中文和繁体中文缺失项归零；格式占位符和 String Catalog 编译检查通过。
- `Token` 在所有语言中保持为 `Token`，中文统一使用“Token 用量”“输出 Token”等表达，不翻译为“词元”。
- 对中文高频入口进行人工校准，修正 Composer、Artifact、Quick Task 等上下文直译，统一为“输入区”“任务产出”“快捷任务”。
- 新增可重复运行的本地化同步与审计脚本，默认只读检查，防止后续版本再次出现语言遗漏或格式参数损坏。

## 1.1.0 - 2026-07-26

### Build 23 · 正式版

- 正式版本统一为 1.1.0（23），主 App、Tests、Share、Files 与 Widget 配置一致。
- 新增 1.1.0“本次更新”内容；升级后强制展示一次，确认后不重复打扰，并永久保留在“设置 → 关于 → 更新记录”。
- 全新目录生成正式签名 Archive；arm64、Team `48H5Y3LNUK`、主包及三个扩展的版本、Bundle ID、Entitlements 与签名校验全部通过。
- 最终版已覆盖安装到 iPhone 17 Pro Max 并成功启动，设备回读 1.1.0（23），主 App 与 Widget Extension 均在运行。
- 安装后真实数据库复核为 Schema v3，升级前后的 3 个会话与 16 条消息保持不变，临时审计副本已删除。

### Build 22

- 使用在线 iPhone 的 1.0.12 Build 13 私有数据库副本完成真实迁移演练；Schema v0 → v3、完整性、外键、行数保持与二次幂等检查均通过，设备原数据未改动，临时副本已删除。
- 全量 Schema、Artifact、Quick Task、动效/触感 smoke 与审计再次通过；Tests Bundle 在 iOS 26.5 Simulator 成功编译签名，Xcode runner 未启动 Test Case 的中断不计为测试通过。
- 面向用户的名称、包名、App Group、iCloud Container、URL Scheme 与签名均复核为 LeoPhoneAgent / `com.leoyuan.leophoneagent.*` / Team `48H5Y3LNUK`。
- 本地网络权限提示改为 LeoPhoneAgent 自有且面向用户的安全 Shell/连接服务说明，移除 VM/SLIRP 工程措辞并同步 7 种语言。
- iOS 26 Continued Processing 动态通配标识按 Apple 官方规则复核通过；连接真机目标的 Release 构建及主 App、Share、Files、Widget 扩展签名验证全部成功。
- 内部 Build 统一升至 22；正式版本号仍保持 1.0.12，本检查点没有安装到手机。

### Build 21

- LeoHaptics 成为全项目唯一触感入口，发送、完成、快捷动作、拖拽与恢复反馈统一受“外观 → 触感反馈”开关控制；不影响系统与键盘触感。
- 首页搜索与 FAB、Composer 文本/语音切换、状态卡等关键过渡开始复用 LeoMotion，并在系统 Reduce Motion 开启时即时切换或只保留淡入淡出。
- 首页同步旋转、聊天加载点、工具 Shimmer 与流式跳点、思考提示、浏览器下载脉冲及语音波纹均加入 Reduce Motion 静态降级；不再无条件常驻运动。
- Composer 的附件、命令、发送和个人任务快捷动作补齐 VoiceOver 名称与操作提示；等待授权、等待用户、挂起、完成、失败及取消状态采用低频 VoiceOver 公告。
- 新增 `IOSAccessibilityMotionAudit.sh`，阻止业务代码绕过 LeoHaptics，并要求所有重复动画文件包含 Reduce Motion 闸门。
- 自动动效/触感审计、QuickTask smoke、MinisTests Bundle 编译和完整 iOS arm64 App 构建均成功；未安装到手机。

### Build 20

- Quick Tasks 新增 Composer 固定区，默认选择前三个内置任务，用户可在设置中自由组合且最多固定三个；删除自定义任务会同步清理失效引用。
- 聊天 Composer 使用原生横向快捷动作，在不改变稳定输入栏结构、AnyView 擦除和高度校正链路的前提下，一键准备模板 Prompt 与输出约束。
- 首次空会话首页复用相同的个人快捷任务，点击后通过既有 Quick Action 状态机创建新会话并填入模板，避免延时跳转和重复投递。
- 会话首页新增紧凑、标准、舒展三档密度，只调整列表间距与图标尺寸，不覆盖字号和系统无障碍设置。
- 新任务运行策略支持 Standard 与 Background Ready；后者在发送时启用现有增强后台、Live Activity 和任务通知路径，且界面明确说明后台时长仍由 iOS 与当前 Keep-Alive 能力决定。
- 发送按钮长按可对单次任务选择 Standard 或 Background Ready，不改变全局默认值。
- Composer 固定项的默认值、三项上限、持久化、去重和删除清理已加入测试与 smoke runner；完整 iOS arm64 App 构建成功，未安装到手机。

### Build 19

- 现有可编辑 Quick Tasks 升级为个人任务模板，保留 1.0.12 AppEntity 稳定标识和旧 AppEnum 兼容入口。
- Prompt 支持 `{{topic}}` 形式的输入槽位，自动去重并在编辑器显示；Shortcuts 可使用每行 `name=value` 为槽位传值。
- 每个模板可选自动、精简文本、Markdown、JSON 或保存 Artifact 五种结果约束，执行时作为明确输出契约追加到 Prompt。
- 模板可导出为 `.leotask.json` 本地文件，导入时生成新的自定义标识，不覆盖原模板或破坏已有 Shortcuts。
- `SendPromptResult` 新增输出模式和 Artifact 文件名数组；发送、追问、重试与快捷任务在等待完成时均返回会话产物，方便下一个 Shortcut Action 消费。
- 旧 v1 存储 JSON 缺少新字段时自动使用 `automatic`，不会丢失现有自定义任务。
- 模板独立 smoke runner 通过，测试 Bundle 编译链接成功，完整 iOS arm64 App 构建成功；未安装到手机。

### Build 18

- Artifact 接入现有 CloudKit V2 共享区：`ArtifactV2` 同步元数据和回收站状态，`ArtifactVersionV2` 以 CKAsset 同步不可变版本文件。
- Artifact 云同步作为独立分类默认关闭，需在 iCloud Sync 设置中明确开启；开启时才分批标记现有成果。
- 默认单个 Artifact 云版本上限为 25 MB，可选 1/5/25/100 MB；超限版本保留在本机，不进入 CKAsset 上传队列。
- 下载的 CKAsset 必须同时通过文件大小和 SHA-256 校验，再原子复制到本机受控目录；CloudKit 临时文件不会被持有。
- 远端合并不反向产生本地脏记录；回收站是可恢复状态，永久删除才为 Artifact 和其版本发送 tombstone，并阻止删除窗口期内的旧记录复活。
- Artifact/Schema smoke 通过，测试 Bundle 编译链接成功，完整 iOS arm64 App 构建成功；没有安装到手机，也没有开启用户的 Artifact 云同步。

### Build 17

- 任务通过 `file_write`、`file_edit` 或 shell 在会话 workspace 生成的用户成果，现在会自动进入该会话的 Artifact Tray。
- Artifact 记录同时保留原始 Files 路径和来源聊天消息；移入回收站或永久删除 Artifact 不会改动原始 workspace 文件。
- 同一会话、同一源路径使用 SHA-256 去重：内容未变时不重复创建，内容变化时追加不可变版本。
- Artifact Tray 新增版本历史，可查看源路径、版本号、时间与大小，并对任意历史版本使用 Quick Look 或系统分享。
- 自动收录仅针对 `/var/minis/workspace/` 中的用户成果，单文件上限 100 MB，不收录内部中间文件。
- Schema Contract 升级至 v3；Schema 与 Artifact smoke 通过，测试 Bundle 编译链接成功，完整 iOS arm64 App 构建成功；未安装到手机。

### Build 16

- 每个聊天的更多菜单新增 Artifacts 入口，按会话展示任务生成的本地成果。
- 新增原生 Artifact Tray，完整覆盖加载、空内容、错误、正常列表与回收站状态。
- 成果支持系统 Quick Look 预览、系统分享、下拉刷新、移入回收站、恢复与永久删除。
- 列表使用动态字体、组合式 VoiceOver 标签与系统深浅色；列表变化动画遵循“减少动态效果”。
- 本阶段只消费 Build 15 的本地数据，不创建成果、不改变聊天消息引用，也不写入 CloudKit。
- 测试 Bundle 编译链接成功，完整 iOS arm64 App 构建成功；未覆盖安装手机上的 1.0.12 稳定版。

### Build 15

- 新增设备本地 Artifact 数据模型，统一文档、图片、音频、视频、代码、压缩包与普通文件成果。
- 每个成果支持不可变版本记录、当前版本指针、SHA-256 完整性摘要与安全的相对路径存储。
- 文件先写入独立 staging 目录，再与 SQLite 事务协同提交；失败时清理临时文件并回滚数据库。
- 新增软删除、恢复与永久清理生命周期，文件名和读取路径均进行越界防护。
- Schema Contract 升级至 v2，并以幂等迁移创建 Artifact 表与索引；本阶段尚未开启 CloudKit 写入。
- 本地生命周期 smoke runner、Schema runner 均通过，测试 Bundle 编译链接成功，完整 iOS arm64 App 构建成功。

### Build 14

- 新增由生产 ChatStore 启动路径直接调用的版本化 Schema Contract，为后续 Artifact 数据迁移建立安全门。
- 核心会话、消息与压缩标记表支持事务式幂等修复，并记录独立 contract version。
- 旧消息迁移会保留原行，补齐 `updated_at`，并从 `parts_json` 回填本地 `part_flags`。
- 新增四组 XCTest 契约用例和可在 macOS 直接执行的 SQLite smoke runner。
- 独立 smoke runner 4/4 通过，测试 Bundle 编译链接成功，完整 iOS arm64 App 构建成功。
- iOS Simulator 测试 runner 仍卡在 `waiting for workers to materialize`，未将中断执行记为 XCTest 通过。

## 1.0.12 - 2026-07-26

- 快捷任务主入口从硬编码 AppEnum 升级为可扩展 AppEntity，Siri 与快捷指令可动态读取任务库。
- 设置新增“快捷任务”管理页，可创建、编辑、排序和删除自定义任务，并可恢复八个内置任务。
- 八个内置任务使用稳定标识；1.0.11 及更早版本保存的 AppEnum 快捷指令继续由兼容入口执行。
- 快捷任务名称、提示词或图标变化后会刷新系统快捷指令参数。
- 新增任务标识、存储归一化和自定义任务生命周期契约测试；主 App 与独立测试 Bundle 编译链接成功。

## 1.0.11 - 2026-07-26

- `isProcessing.didSet` 缩减为 `_deinitSnapshot` 更新和显式转移分发。
- 新增 `handleProcessingStarted()`，按原顺序管理云同步延迟、旧 post-stop hold 清理与 StreamingHangLogger。
- 新增 `handleProcessingStopped()`，按原顺序管理 post-stop hold、卡顿监控释放、安全快照、离屏通知与技能刷新。
- 保留后台/挂起/会话切换时禁止同步重建大型视图的 0x8BADF00D 防护。
- 通用 iOS 主 App 与独立逻辑测试 Bundle 编译链接成功。

## 1.0.10 - 2026-07-26

- 新增可单测的 `AgentProcessingTransition`，明确区分 `.started`、`.stopped` 和 `.unchanged`。
- `isProcessing.didSet` 改为消费显式边沿转移，不再把布尔组合散落在副作用入口。
- 保持 iCloud 延迟、post-stop hold、卡顿监控、前台快照、离屏通知和技能刷新等原执行顺序不变。
- 增加 `false→true`、`true→false` 与两种重复赋值的纯逻辑契约测试。
- 通用 iOS 主 App 与独立逻辑测试 Bundle 编译链接成功。

## 1.0.9 - 2026-07-26

- 新增仅设备本地的 `agent_run_state`，原子保存 Run、会话、开始/更新时间、阶段、工具名和隐私安全原因码。
- 首次打开进程时，将上一进程遗留的非终态 Run 转为“等待用户继续”，不会自动恢复执行。
- 会话加载与启动徽章对账同时读取持久 Run 状态，覆盖流式文本中途被 iOS 终止时消息尾部启发式无法识别的盲区。
- 新任务会终结同会话被取代的旧 Run，避免过期的暂停标记在后续重新出现。
- 增加意外终止恢复纯逻辑测试；主 App 与测试 Bundle 编译成功，迁移/恢复/取代 SQL 已独立验证。

## 1.0.8 - 2026-07-26

- 将外观设置支持组件从 5000 余行的 `ContentView.swift` 纯移动到独立设置文件。
- 将首页同步状态动画与强制同步提示条纯移动到独立状态组件文件。
- 保持现有界面、交互、文案和动画行为不变，先降低后续状态机与任务控制台升级的耦合风险。
- Xcode 工程引用、通用 iOS 构建与独立逻辑测试 Bundle 编译均通过。

## 1.0.7 - 2026-07-26

- 新增 Apple Capabilities 能力中心，集中展示原生能力、系统授权状态、可执行动作、示例和数据去向。
- 授权探针只读查询，不会因为打开页面而主动弹出系统权限请求。
- Provider 新增“测试并保存”流程：保存前先拉取模型并完成一次真实请求，失败时可明确选择仍然保存。
- 自动日志进一步移除提示词、回复正文、工具参数、OAuth Token 片段、通知标题和浏览网址。
- 明确 HomeKit、HealthKit 和后台持续执行等系统边界，不承诺 iOS 不允许的无限后台运行。

## 1.0.6 - 2026-07-26

- 新增小号和中号主屏幕任务组件，通过 App Group 共享隐私安全的任务快照。
- 中号组件新增语音入口，打开 App 后直接创建对话并启动语音输入。
- iOS 26 接入 `BGContinuedProcessingTask`，为用户启动的长 Agent 任务提供锁屏后持续处理与系统进度。
- 持续处理被系统撤销时进入暂停、取消当前命令和可恢复链路。
- 后台状态日志改为纯元数据，不再记录工具错误原文、输出预览、工具描述和完整浏览 URL。
- 调试协议、挂起检测线程和存储空状态继续清理旧产品名称，内部兼容路径与 GPL 法定来源保留。
- 新增 iOS 系统能力与后台执行审计文档。

## 1.0.5 - 2026-07-26

- FFmpeg 框架新增进程内协作取消入口，通过原生清理路径停止转码。
- FFmpeg 工作线程以 50ms 周期响应任务取消，串行锁等待同样可中断。
- 取消的转码返回标准状态 130，不向客户端注册未完成结果。
- 移除完整 FFmpeg 参数日志，避免暴露媒体路径和文件名。

## 1.0.4 — 2026-07-26

- 将停止信号从 shell 会话传入 iSH 原生代理执行层。
- 原生能力的同步等待改为可协作取消的短周期检查。
- 取消后不再注册未完成的文件结果，并返回标准取消状态。
- 重编 iSH ARM64 静态库，保持 iPhone 真机签名链路。

## 1.0.3 — 2026-07-26

- Activity 失败终态新增隐私安全的原因码，不保存服务商错误原文。
- 统一聊天错误、活动时间线与中断恢复动作，支持重试、继续和检查 Provider。
- 本地 Linux 环境启动失败页新增直接重试入口。
- 进一步清理诊断日志中的模型错误正文、工具错误片段与 Provider 响应细节。
- 新增失败原因分类与恢复策略纯逻辑测试。

## 1.0.2 — 2026-07-26

- 浏览器加载、JavaScript、截图、文本提取和 DOM 等待统一接入即时取消。
- 并发工具无论因用户还是系统取消，都会生成配对的取消结果。
- 有排队消息时，停止操作明确区分“继续队列”和“停止全部并清空队列”。
- 可分享诊断日志只记录结构化元数据，不再记录提示词、回复或工具内容预览；隐私模式也会遮盖日志中的已知环境变量值。
- 新增队列停止策略纯逻辑测试。

## 1.0.1 — 2026-07-26

- 新增聊天实时状态卡与设备本地活动时间线。
- 权限请求明确展示访问内容和数据去向。
- 增加等待授权、浏览器接管、后台超时和并发限制等安全原因提示。
- 统一 iOS 视觉层级、动效、触觉反馈与“减少动态效果”适配。
- 完成 LeoPhoneAgent 独立签名、隐私声明、快捷指令和服务商配置加固。
- 新增升级后“本次更新”提示和“设置 → 关于 → 更新记录”。

## 1.0 — 2026-07-26

- 建立 LeoPhoneAgent 独立 iOS 产品基础版本。
- 支持对话、工具调用、本地工作区与多个 AI 服务商。
