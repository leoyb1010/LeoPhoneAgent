# LeoPhoneAgent Android 全面优化方案（2026-08）

基线:`ca737b12`(android-v1.0.0-alpha.9)。本方案基于对 458 个 Kotlin 文件 / 15.4 万行
的真实代码走读,每条结论都标注出处;没有出处的是提案,不是现状。

---

## 〇、现状盘点(先说清楚已经有什么)

| 能力 | 现状 | 出处 |
|---|---|---|
| Agent 工具 | shell_execute / file_read / file_write / file_edit / read_image / browser_use / memory_get+write | `tools/AgentTools.kt` |
| 消息渲染 | Markdown + 行内图片/视频/音频 + KaTeX(WebView 池)+ 代码高亮 | `ui/markdown/`、`ui/chat/KatexWebViewPool.kt`、`ui/media/InlineMediaPlayer.kt` |
| HTML 预览 | WebPreviewBottomSheet / 全屏 / 文件预览,已接入 ChatScreen | `ui/preview/`、`ui/sandbox/FilePreviewScreen.kt` |
| Skill | 管理 + 浏览 UI;启用的 Skill 自动挂成 `/<skill>` 斜杠命令 | `ui/settings/Skills*.kt`、`ChatViewModelSlashExt.kt:86` |
| MCP | 集成设置页 + OAuth;沙箱内 minis-mcp-cli 与 UI 共用 servers.json | `ui/settings/MCPIntegrationsScreen.kt`、`PRootKernel.registerGlobalBindMounts` |
| CLI 管理 | 四家 CLI 安装/更新/状态/终端启动,模型偏好 + API Key 一次性内存注入 | `sandbox/CliToolCatalog.kt`、`CliToolLaunch.kt` |
| Mac 连接 | RelayFleetClient:远程发任务、轮询事件、审批答复;keep-alive Worker | `relay/RelayFleetClient.kt`、`RelayBodyKeepAlive.kt` |
| 系统集成 | assistant(ACTION_ASSIST)/tile/widget/shortcut/share/scheduled/accessibility(Power) | 对应包名目录 |

**结论:地基远比"一个聊天 App"厚。问题不在缺能力,在于能力之间没打通、入口埋得深、
输出端没有形成"交付物"概念。**

---

## 一、P0:CLI 入口重构——对话即入口

### 问题(实测确认)
装好 Claude Code 后,唯一用法是 设置 → 开发 CLI → 打开终端,四层深,且终端是裸 PTY。
聊天的模型选择器(`ChatModelPickerSheet.kt`)只认 `ProviderType` 六家 API
(anthropic/gemini/openAI/openRouter/xAI/kimiCode),**已安装的 CLI 完全不在里面**。

### 方案:CLI 成为聊天的第五类"执行引擎"

Mac 端已经趟过这条路:leocodebox 的 harness 方言层
(`src/mac/leocodebox/server/modules/leophone/harness-dialects.ts`)把
Claude(`--output-format stream-json`)、Codex(app-server JSON-RPC)、Grok(ACP)
统一成一个会话协议。**Android 抄同一套设计,跑在 PRoot 里:**

1. **引擎抽象**:`ChatEngine` 接口,现有 API 直连是 `ApiEngine`,新增 `CliEngine`——
   经 `PersistentShell` 以非交互模式驱动 CLI(Claude `-p --output-format stream-json`、
   Codex `exec --json`),流式帧翻译成现有 `EngineChunk`(Delta/Completed/Failed,
   `relay/MinisHarnessRouter.kt:19` 已有这个模型,直接复用)。
2. **选择器改造**:ModelPickerSheet 底部加「本机 CLI」分组,已安装的 CLI 直接列出,
   带版本号;未安装的灰显一行「去安装」跳 CLI 管理页。选中后会话顶部芯片显示
   `Claude Code · 本机`。
3. **装完即用**:安装成功弹窗(现在只有「确认」)加一个主按钮「开始对话」——
   新建会话并把引擎切到刚装好的 CLI。入口深度从 4 层降到 0 层。
4. **审批复用**:CLI 的工具审批(Claude stdio 审批帧)映射到现有聊天审批 UI,
   与 relay 远程审批同一套组件。
5. 终端入口保留(高级用户 debug 用),但不再是唯一入口。

### 1.1 CLI 使用交互全景(实测走查 → 目标体验)

**现状六幕,每一幕都有实测证据:**

| 幕 | 现状(Fold8 实测) | 问题 |
|---|---|---|
| 发现 | 设置四层深才见「开发 CLI」 | 首页/对话完全感知不到 CLI 存在 |
| 安装 | 弹窗确认→单行进度(180 字符截尾)→「已经就绪」 | 过程黑盒;失败时只有截尾文本,无日志/重试 |
| 启动 | 「打开终端」→ 整屏黑 + 一行**预填命令**,`export PATH=…; claude` 原样暴露 | **命令不自动执行**;无任何提示要点屏幕→唤键盘→按回车;实测 adb 回车两次未进 PTY,tap 聚焦后才通——真实用户会认为"坏了" |
| 首启 | Claude 首启显示主题选择 wizard(渲染质量好:diff 配色/语法高亮全对) | 首启要过 3-4 屏英文 wizard,与 App 的中文体验断裂 |
| 登录 | 走 CLI 自己的 OAuth(见 1.2) | URL 跳转链路已有但从未按登录场景验收 |
| 对话 | 裸 TUI + 底部特殊键行(Esc/Tab/Ctrl/方向/C-c/C-d,这部分做得好) | 竖屏 TUI 行宽窄;无会话保活提示;切走再回可能丢会话 |

**目标体验(P0 的落地细则):**
1. 「打开终端」改「启动」:预填命令自动回车执行,启动期间显示 spinner + "Claude Code 正在启动(首次约 30-60 秒)";命令行本身隐藏进可展开的"详情"。
2. 首启接管:检测 `~/.claude.json` 不存在时,由 App 预写主题(跟随 App 深浅色)和
   onboarding 跳过项,让用户直达登录/对话——CLI 的 wizard 一屏都不出。
3. 键盘焦点:进终端即自动聚焦 + 弹键盘(现在要 tap 一次);accessory bar 加「粘贴」键
   (登录授权码全靠粘贴,现在只能长按)。
4. 会话保活:CLI 会话挂前台服务(RelayBodyKeepAlive 同款底座),切走不断;
   终端页顶部显示会话状态芯片(运行中/等输入)。

### 1.2 登录授权矩阵(逐家核实)

**基建结论(代码已确认):** PRoot 不隔离网络命名空间——沙箱内 CLI 绑定的
`127.0.0.1:PORT` 与手机浏览器是**同一个 loopback**,OAuth 的 localhost 回调理论可达;
`BROWSER=/usr/local/bin/minis-open`(PRootKernel:100)已把 CLI 打开的 URL 经 OSC 标记
路由到应用内浏览器(MinisOpenUrlBroker→UrlPreviewSheet)。缺的不是机制,是按登录场景
把体验串起来并逐家验收。

| CLI | 登录方式 | 沙箱内可行性 | 要补什么 |
|---|---|---|---|
| Claude Code | OAuth:开浏览器 → console.anthropic.com 授权 → localhost 回调,**失败时降级为授权码回贴** | 回调可达(同 loopback);回贴流程稳 | 应用内浏览器完成授权后自动切回终端;授权码复制→终端「粘贴」键;逐台验收回调路径,不通则引导回贴 |
| Codex CLI | ChatGPT OAuth,固定 `localhost:1455` 回调;或 API Key | 回调可达,同上 | 同上;另:1455 被占用的兜底提示 |
| Grok Build | xAI OAuth / API Key | 同上 | 同上 |
| Cursor | `agent login` 打印 URL → 浏览器确认 → **CLI 轮询服务端**(设备码式,无 localhost 回调) | 最稳,无回调依赖 | URL 自动弹应用内浏览器;确认后回终端有成功提示 |
| 兜底 | LeoPhoneAgent 已有的 API Key 一次性注入(alpha.9 已做) | 已验证 | 在登录界面把"用 LeoPhoneAgent 的 Key"作为并列选项呈现,而不是藏在「模型与授权」里 |

**统一「连接账号」流程(提案):** CLI 卡片上的「模型与授权」升级为「账号」区,
显示登录态(已登录邮箱/未登录);点「登录」→ App 直接以非交互方式驱动
`claude /login` 类流程,URL 自动开应用内浏览器,完成后回卡片打绿勾——
用户全程不见终端。OAuth 凭据仍留在沙箱内 CLI 自己的配置文件里,
维持 alpha.9 的"OAuth 不出沙箱"红线。

### 1.3 Cursor 上手专章

Cursor 是四家里唯一"非官方支持 musl"的,alpha.9 已经做完最重的活
(Alpine Node 替换/原生模块重建/glibc shim/SHA-512 校验/原子备份回滚,
`CliToolCatalog.cursorAlpineCompatibility()`)。让它真正可用还差三件事:

1. **登录**:走 1.2 的设备码流程(Cursor 恰好是最适配手机的登录方式);
   或设 `CURSOR_API_KEY`(已支持一次性注入)。
2. **使用形态**:`agent` 的 TUI 与 Claude 同级,竖屏可用;但 Cursor 的价值在
   agent 模式改代码——建议在 CLI 卡片加「在项目中启动」:选一个挂载文件夹
   (MountedFolderCoordinator 已有)作为 cwd 启动,而不是永远从 /root 起。
3. **模型**:`--model` 已支持(安全 quoting);卡片上的模型输入框改为
   常用模型下拉(gpt-5.2 / claude-opus-5 / composer-2)+ 自由输入,减少拼写错。
4. **已知限制要写进 UI**:Cursor 更新可能重新覆盖 node(升级事务已处理,
   但用户要知道"更新后首启会慢");Merkle 补丁依赖上游 index.js 结构,
   上游大版本可能失配——失败时提示"回滚到上一版本"(事务已支持)。

### 1.4 全屏 UX 走查(Fold8 展开态实测,坐标为证)

**首页**
- 三步引导卡完成后不折叠,永久占左半屏(实测:完成态仍显示"请先完成第 1 步"逻辑树)。
- 右栏快捷入口只有三张卡(操作手机/调研/自动化),CLI、终端、远程 Mac 全都不在——
  首页应有「继续上次会话」和最近会话列表。
- 展开态左右两栏宽度 1:1,左栏引导信息密度低,浪费大屏。

**设置(整页走查)**
- 「开发 CLI」与「环境变量」用同一个 Terminal 图标同一个绿色(SettingsScreen:224-236),
  视觉无法区分——CLI 应换图标。
- IA 三组的分组逻辑混乱:外观夹在「LLM 提供商」和「连接的设备」之间;
  「技能/人格/记忆」叫"AGENT 运行时",但 CLI/环境变量/存储不在这组——
  重组为:智能体(提供商/模型组/CLI/技能/记忆/MCP/环境变量)、工作区(外观/存储/挂载)、
  连接(远程机器/系统权限/后台)、关于。
- 设置页展开态仍是单栏全宽拉通,行宽 1768px 读起来累——双栏(左导航右内容)。

**CLI 管理页**
- 每张卡片四个动作(更新/打开终端/模型与授权/官网 chip)平铺,主次不分:
  「打开终端」是主动作却和「更新」同级同大小(实测同为 74px 高的文字按钮)。
  改为:主按钮「启动」(填充色)+ 次按钮「更新」+ 溢出菜单(模型/授权/卸载/日志)。
- 官网 chip(claude.ai)在右上角可点但无点击反馈,像个标签——要么做成链接样式要么去掉。
- 无「卸载」入口(装了就卸不掉,只能进终端 rm)。
- 版本行 `2.1.238 (Claude Code)` 冗余(卡片标题就是 Claude Code)——只留版本号+检查更新时间。

**终端**
- 顶栏只有关闭和主题刷两个按钮,缺:粘贴、字号调节、会话切换。
- 特殊键行做得好(Esc/Tab/Ctrl/方向/C-c/C-d 齐全),但**竖屏时被软键盘顶到中部**的
  问题在展开态不存在、封面屏(1080×1728)未验收——列入 Fold8 封面屏验收项。
- 命令回显暴露实现细节(export PATH=…),见 1.1。

**对话页**
- composer 左下「添加附件」与右下「语音/发送」分居两角,单手(封面屏)够不到左下——
  附件并入右侧按钮组或长按发送呼出。
- 模型芯片(顶部「LeoPhoneAgent 默认」)点击展开模型选择,但芯片不带下拉箭头暗示,
  可发现性差。
- 工具调用卡片默认收起且无进入动效,流式输出无逐字过渡(见 2.2)。


安全边界不变:API Key 仍走 `CliLaunchResolver` 的一次性内存注入;OAuth/订阅令牌
仍禁止导出;非交互模式不新增任何 URL 或用户输入拼接。

### 验收
新会话 → 选 Claude Code(本机)→ 提问 → 流式回答含工具调用卡片 → 审批 → 完成;
全程不见终端。Fold8 双尺寸 + 中文全覆盖。

---

## 二、全局 Review:代码健康与体验债

### 2.1 代码健康(按风险排序)

| 问题 | 证据 | 建议 |
|---|---|---|
| 巨石文件:ChatViewModel **9856 行**、ChatScreen **6109 行** | wc -l 实测 | 已有拆分先例(SlashExt/MentionExt/UiStateExt),继续按"引擎/附件/语音/渲染"切;新功能(CliEngine)绝不再往里加 |
| 动效几乎缺席:6109 行的 ChatScreen 只有 25 处 animate | grep 实测 | 见 2.2 |
| relay 事件靠轮询 `/events?after=` | `RelayFleetClient.kt:90` | Mac 端已提供 SSE(leophone 模块),换 OkHttp SSE,省电且实时 |
| 主题层薄:ChatColors + Theme 两个文件 | `ui/theme/` | 引入语义 token(参考 Mac 端 tokens.css 的教训:blanket 规则会反噬),支持 Material You 动态取色 |
| CLI 状态检测串行跑四家 | `CliToolsViewModel.refresh` 循环 | 并发 + 缓存上次结果,进页秒出 |

### 2.2 体验清单(从用户路径出发)

**首屏与导航**
- 首页三步引导(连模型→选模型→启动任务)完成后仍占半屏——完成后应折叠成一行状态条。
- 设置信息架构:「LLM 提供商 / 模型组 / 开发 CLI / 环境变量 / 技能 / 记忆 / MCP」分散在
  三个分组,心智上都是"Agent 的脑和手",建议合并为「智能体」分组(Mac 端 1.68.0 已这么分)。
- 预测性返回(Android 15 predictive back)未见适配;Fold8 展开态已是双栏(实测截图确认),
  但设置页仍是单栏拉通——展开态应左导航右内容。

**对话体验**
- 流式输出无逐字动效,工具调用卡片无展开过渡;建议:消息进入 fade+slide 8dp、
  工具卡片 expandVertically、审批卡 spring 弹入——全部尊重"减少动画"系统开关。
- 长回答无大纲/回到顶部;代码块无"复制"浮钮(现在要长按)。
- 触觉反馈:发送/审批/完成关键节点加 HapticFeedback,现在全程无振感。

**CLI 管理页本身**
- 安装进度只有一行 `progressLine`(180 字符截尾),应改为可展开的滚动日志
  (安装失败时用户能看到完整报错——这次排查的痛点就在这)。
- 失败弹窗标题「安装失败」+ 原始 shell 输出,应加「复制日志」和「重试」按钮。

### 2.3 定向 debug 清单
- `CliToolsViewModel` 的 `resultMessage` 成功时放 displayName、失败时放 shell 输出,
  语义混用同一字段,弹窗逻辑靠 `operationSucceeded` 区分——重构成 sealed Result。
- `libproot-loader32.so` 未打包(实测 lib 目录缺失)——arm64-only 没问题,
  但 PersistentShell 仍在设 `PROOT_LOADER_32`,删掉死代码或补上说明。
- 安装超时 10 分钟一刀切;Cursor 的 npm rebuild 在低端机可能超——按 CLI 分级。

---

## 三、发散:让这台手机更强

按"手机 = 全天候贴身 Agent + Mac 的遥控器 + 独立执行体"三个身份展开:

1. **本机 API 网关(对标 Mac 的 Leoapi)**:App 内起 loopback HTTP 服务,
   把已配置的 Provider 以 OpenAI 兼容格式暴露给手机上其他 App(Tasker/快捷指令/浏览器脚本)。
   `webapp/` 包已有 HTTP 基建可复用。Power 版特性,默认关。
2. **通知流 → 任务流**:NotificationListener(Power)把可订阅的通知(快递/账单/日程)
   喂给 Agent 规则,变成主动型助手。`scheduled/` 已有定时任务底座。
3. **拍照即输入**:相机/截图 → read_image 工具已在,补一个分享面板入口
   「发给 LeoPhoneAgent 分析」(`share/` 包已有 receiver,差路由到新会话)。
4. **语音全双工**:`speech/` 已有 22 个文件(识别+TTS),差"边听边答"的对话模式和
   驾驶/锁屏场景的纯语音 UI。
5. **手机作为 MCP 服务器**:把手机能力(定位/短信读取[Power]/相册/传感器)封装成
   MCP server 暴露给 Mac 端的 leocodebox——Mac 上的 Claude 就能"用手机的手"。
   与第五节的连接能力合并实施。
6. **离线兜底**:检测断网时降级到本机小模型(llama.cpp ARM64 在 PRoot 里可跑),
   只做摘要/翻译/改写等轻任务。属探索项,放最后。

---

## 四、输出与生态:从"文本回答"到"交付物"

现状已有 HTML 预览、行内媒体、KaTeX——缺的是**Agent 产物的一等公民地位**:

1. **Artifact 卡片(P1)**:Agent 用 file_write 写出 .html/.md/.svg/.csv 时,
   聊天流里自动出现产物卡片(文件名+类型+预览缩略),点开进 WebPreview 全屏,
   长按分享/导出。判定逻辑挂在 FileWriteTool 的结果路径上,渲染复用现有 preview 组件——
   改动小,感知强。
2. **图片生成**:Provider 层加 image generation(gemini/openAI 已有 API),
   返回落沙箱文件 → 走行内图片渲染(已支持)。
3. **视频**:InlineVideoPlayer 已有(VideoView);补 ExoPlayer 可选依赖处理编码兼容,
   低优先。
4. **富文本导出**:消息/会话导出 PDF(Android PrintManager 原生能力)与分享为图片
   (长图渲染),中文排版验证。
5. **Mermaid 图表**:KatexWebViewPool 的思路复制一份 mermaid 池,```mermaid 围栏
   直接出图。
6. **Skill 生态**:Skill 已能当斜杠命令;补「从 Mac 同步 Skill」——Mac 端
   `/var/minis/skills` 与手机沙箱同名目录经 relay 单向拉取,一处编写两端可用。
7. **MCP 补强**:远程 MCP(SSE/HTTP)+ OAuth 已有雏形(`mcp/oauth/`),
   补连接测试按钮和工具清单展示(对齐 Mac 端 MCP 设置页)。

---

## 五、与 Mac 的连接:从"遥控"到"共生"

现状:能发任务/轮询/审批(RelayFleetClient),Mac 端 leophone 模块提供完整
harness 面(含 SSE、断线续传、会话召回)。差距与补法:

1. **SSE 替换轮询(P1)**:直接消费 Mac 端 `/harness/sessions/{id}/events?after=N`,
   全量回放+实时跟随,断线按 seq 续传——协议已在 Mac 端上线(1.63.0),
   Android 只差客户端。
2. **接管体验进聊天**:远程会话不再是独立 Fleet 页的列表项,而是会话列表里
   带机器名徽标的一条(Mac 端 1.68.0 工作台已这么做,两端镜像)。
   composer 的 @ 提及扩展 `@cortex` 这类机器名,发出去就是远程任务。
3. **文件互通(P1)**:手机 ↔ Mac 沙箱文件传输。经 relay 加 `/files` 面
   (上传下载均走既有鉴权),聊天里"发送到 Mac / 从 Mac 取回"。
4. **剪贴板接力**:双向剪贴板同步开关(Power),小改动大体感。
5. **Leoapi 借用**:Mac 端已有 `/v1/grok/token` 借用端点——手机把 Mac 的登录态
   借来跑本机 CLI(方向已验证,补 UI 开关)。
6. **配对体验**:RelayFleetScreen 现在要手填 relay 地址;加二维码配对
   (Mac 端设置页出码,手机扫码写入 relay.json 等价配置)。

---

## 六、路线图

| 版本 | 内容 | 判定 |
|---|---|---|
| **alpha.10** | 1.1 启动体验修整(自动执行/spinner/焦点/粘贴键)+ 1.2 登录流程串联(四家逐一验收)+ CLI 页日志可见 + 2.3 debug 清单 | 装完→登录→对话全程不卡壳;封面屏终端键盘布局验收 |
| **alpha.10.5** | 一、CLI 对话引擎(Claude 先行)+ 1.3 Cursor「在项目中启动」 | 装完 Claude 即可在聊天里对话;Fold8 双尺寸中文验收 |
| **alpha.11** | 四.1 Artifact 卡片 + 二.2 动效第一批(消息/工具卡/触觉)+ 1.4 设置 IA 重组与 CLI 卡片改版 | HTML 产物一键预览;动效尊重系统开关 |
| **alpha.12** | 五.1 SSE + 五.2 远程会话进会话列表 + 五.6 扫码配对 | 断线续传不丢帧;@机器名可发任务 |
| **beta.1** | 四.2 图片生成 + 四.6 Skill 同步 + 三.1 本机网关(Power) | 双 flavor 全量回归 |
| 探索线 | 三.5 手机 MCP 服务器、三.6 离线小模型 | 原型验证后再排 |

每一步都走既定门禁:定向测试 → Standard/Power 全量 507 项 + lint → `--max-workers=1`
双 Release → Fold8 实机(覆盖安装/冷启动/ACTION_ASSIST/Logcat)→ 签名校验。

## 风险
- CLI 非交互模式的流式协议随上游版本漂移(Codex 尤甚)——方言层要带协议版本探测,
  未知帧透传不崩(Mac 端同款教训)。
- PRoot 下长驻 CLI 进程的内存压力:Fold8 8GB 可行,低端机需要会话级进程复用上限。
- SSE 长连接与厂商杀后台:RelayBodyKeepAlive 已有前台服务底座,SSE 挂进去而不是新开。
- 任何新下载面(Skill 同步/文件互通)都必须继承现有 HTTPS 白名单+限额+摘要校验纪律。
