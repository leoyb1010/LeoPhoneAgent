# leocodebox 生图资产规划与提示词

> 日期：2026-07-12  
> 适用产品：leocodebox macOS 本地 Agent 工作台  
> 目标：补齐品牌、首次使用、关键空状态、错误恢复和发布展示所需视觉资产，同时保持开发工具的操作效率。

## 1. 视觉判断

leocodebox 是面向开发者的本地生产力工具，不是内容社区或营销网站。视觉资产应承担三类明确职责：

1. **建立品牌识别**：启动、欢迎、关于页和安装包需要形成统一的个人品牌记忆。
2. **解释不可见的系统状态**：本地 Agent 探测、工作区初始化、任务为空、浏览器尚未运行等状态，可以用简洁场景帮助理解。
3. **缓解中断和失败**：CLI 未安装、服务启动失败、断线、无 Git 仓库等错误页，需要让用户一眼区分原因和下一步。

不建议在聊天消息、设置表格、终端、文件树、Git diff、LeoAPI Provider 列表中使用大幅生图。这些是高频操作面，图片会抢占信息空间并降低扫描效率。

### 统一设计语言

- 风格关键词：`premium macOS developer tool`、`editorial technical illustration`、`precise`、`quiet confidence`。
- 画面语言：真实物理材质与抽象计算结构结合，强调本地设备、工作区、终端流和多 Agent 协作。
- 品牌主色：青绿色 `#168F86`；辅助色可使用铜橙 `#D9784A`；中性色为冷白、石墨、银灰。
- 禁止：AI 紫蓝渐变、霓虹赛博城市、机器人头像、拟人化大脑、漂浮玻璃卡片、随机代码文字、廉价 3D 卡通。
- 所有 UI 内资产不得包含文字、Logo、按钮、窗口标题或可读代码。文字由前端渲染，避免模型乱码。
- 同一构图必须输出浅色、深色两版；不能只把浅色图机械反相。
- UI 内图片默认 WebP；需要透明背景时同时保留 PNG 母版。

## 2. 目录规范

所有最终资产放入以下目录，不要直接覆盖现有 Logo：

```text
public/visuals/
├── brand/
├── onboarding/
├── empty-states/
├── errors/
├── agents/
├── release/
└── textures/
```

源文件和模型原始输出放入：

```text
design/source-images/
├── brand/
├── onboarding/
├── empty-states/
├── errors/
├── agents/
└── release/
```

命名规则：

```text
{场景}-{light|dark}[-{尺寸或倍率}].webp
```

输出要求：

- 色彩空间：sRGB。
- UI 图：至少 2x 分辨率，前端按一半尺寸显示。
- 无透明需求的图输出 WebP quality 82-88。
- 透明资产保存 PNG 母版，再转 WebP；检查透明边缘无黑边或白边。
- 每张图保留至少 12% 安全区，主体不得贴边。
- 不在位图中生成文案。

## 3. 第一优先级：必须补齐（10 个场景，20 张浅深图）

### A01 启动品牌场景

- **用途**：Electron 本地服务启动页，替换目前纯文字和日志占满屏幕的临时感。
- **目标文件**：
  - `public/visuals/brand/launch-light.webp`
  - `public/visuals/brand/launch-dark.webp`
- **画布**：2400 x 1500，横向 16:10。
- **构图**：视觉主体位于右侧 55%，左侧保持干净，供启动状态和错误日志排版。
- **提示词**：

```text
Create a premium macOS developer-tool launch background for a product called leocodebox, without rendering any text or logos. Show a precise abstract local-computing scene: a compact brushed-aluminum workstation core on the right, several restrained terminal-like signal paths converging into one calm teal status light, subtle layered workspace planes, and a sense that local services are waking up. Editorial industrial design, Apple-quality material rendering, quiet confidence, highly legible negative space on the left for UI text, crisp edges, soft physically plausible lighting, cool neutral palette with restrained teal #168F86 and tiny copper-orange #D9784A accents. No people, no robot, no brain, no cloud symbol, no readable code, no UI cards, no neon cyberpunk, no purple-blue gradient, no bokeh, no text. 16:10 horizontal composition, production-ready app background.
```

- **浅色补充**：`cold white and silver environment, subtle gray shadows, no beige`。
- **深色补充**：`graphite-black environment, charcoal metal, controlled highlights, true dark background, no navy wash`。

### A02 首次欢迎 / 本地 Agent 工作台

- **用途**：首次引导首屏，解释“本地发现并控制 Agent”。
- **目标文件**：
  - `public/visuals/onboarding/local-workbench-light.webp`
  - `public/visuals/onboarding/local-workbench-dark.webp`
- **画布**：1800 x 1200，3:2。
- **构图**：主体靠右；左侧约 42% 留白放标题和开始按钮。
- **提示词**：

```text
Design an elegant editorial technical illustration for a local AI coding-agent workbench on macOS. A single personal Mac workstation is the center of control, with five distinct but abstract command-line channels entering from the local machine and organizing into one coherent workspace. Represent agents as unique geometric signal signatures rather than mascots or company logos. Include subtle motifs of a folder tree, terminal cursor, source-control branches, and a browser viewport, all integrated into one physical desk-scale system. Premium developer product, precise and calm, restrained teal #168F86 as the main accent and minimal copper orange #D9784A for active signals, cool silver and graphite neutrals. Keep the left 42 percent quiet and uncluttered for Chinese UI copy. No text, no readable code, no humanoid robot, no cloud server, no generic AI brain, no floating dashboard cards, no purple gradient, no stock-photo look. 3:2 horizontal, sharp high-end product illustration.
```

### A03 CLI 自动发现

- **用途**：引导中的 Agent 检测步骤，以及重新扫描 CLI 时的视觉说明。
- **目标文件**：
  - `public/visuals/onboarding/cli-discovery-light.webp`
  - `public/visuals/onboarding/cli-discovery-dark.webp`
- **画布**：1600 x 1000。
- **提示词**：

```text
Create a clean technical illustration explaining automatic discovery of locally installed command-line coding agents on a Mac. Show a minimal cross-section of a local file system and shell environment: home directory, PATH routes, package-manager locations, app-support folders, and executable nodes being scanned by one precise teal sweep. Discovered executables illuminate as small distinct nodes; unavailable paths remain subtle. The scene must communicate local-only inspection and portability across different Macs without using cloud imagery. Premium macOS utility aesthetic, sparse editorial composition, accurate geometric hierarchy, cool white or graphite background depending on theme, teal #168F86 discovery signal, tiny copper-orange confirmation markers. No text, no fake terminal commands, no logos, no people, no robot, no magnifying-glass cliché, no neon, no purple-blue gradient, no UI screenshot.
```

### A04 未选择工作区

- **用途**：`MainContentStateView` 的主空状态。
- **目标文件**：
  - `public/visuals/empty-states/workspace-unselected-light.webp`
  - `public/visuals/empty-states/workspace-unselected-dark.webp`
- **画布**：1200 x 720，透明或近透明背景。
- **提示词**：

```text
Create a compact premium empty-state illustration for a developer app when no workspace folder is selected. Show one precise open workspace frame made from layered folder planes, with a restrained terminal cursor and source-control branch waiting inside. The object should feel ready but inactive, not sad or broken. Isometric editorial product illustration, clean geometry, subtle brushed-metal and translucent paper-like layers, teal #168F86 as a small focus accent, cool neutral palette. Centered object with generous transparent or nearly transparent margins, readable at 320 pixels wide. No text, no icon labels, no people, no robot, no cloud, no decorative blobs, no purple gradient, no heavy shadow.
```

### A05 新会话 / 选择 Agent

- **用途**：聊天区尚未选择 Agent 或尚未发送消息时，替换单纯的大面积空白。
- **目标文件**：
  - `public/visuals/empty-states/new-session-light.webp`
  - `public/visuals/empty-states/new-session-dark.webp`
- **画布**：1200 x 720，透明背景。
- **提示词**：

```text
Create a refined compact empty-state illustration for starting a local coding-agent conversation. Show a quiet command prompt at the center and several distinct local agent signal paths available around it, with exactly one path softly ready to activate. The visual should suggest choosing a tool and beginning work, not social messaging. Minimal technical editorial style, crisp geometric lines, subtle depth, teal #168F86 active point, graphite and silver neutrals, tiny copper-orange cursor accent. Transparent background, generous negative space, optimized to remain clear at 280-360 pixels wide. No speech bubbles, no mascot, no people, no robot, no readable code, no text, no logos, no cloud, no purple or blue glow.
```

### A06 无任务 / Task Master 空状态

- **用途**：`TaskEmptyState`，让任务管理不再像未完成模块。
- **目标文件**：
  - `public/visuals/empty-states/tasks-empty-light.webp`
  - `public/visuals/empty-states/tasks-empty-dark.webp`
- **画布**：1200 x 720，透明背景。
- **提示词**：

```text
Create a sophisticated empty-state illustration for a developer task board with no tasks yet. Depict a precise planning surface with three understated stages connected in sequence, a single unassigned work token waiting at the entry point, and a subtle link to a source-code workspace. The image should imply turning a requirement into actionable local-agent work. Premium productivity-tool illustration, restrained geometry, flat-to-isometric hybrid, cool neutrals, teal #168F86 for the workflow path, one tiny copper-orange priority marker. Transparent background, no text, no checklists with fake writing, no people, no robot, no celebratory confetti, no gradients, no UI cards.
```

### A07 浏览器任务未启动

- **用途**：Browser Use 面板空状态。
- **目标文件**：
  - `public/visuals/empty-states/browser-idle-light.webp`
  - `public/visuals/empty-states/browser-idle-dark.webp`
- **画布**：1200 x 720，透明背景。
- **提示词**：

```text
Create a compact technical empty-state illustration for a local browser automation panel before a session starts. Show a clean browser viewport outline connected directly to a local terminal cursor and a small inspection path, suggesting controlled navigation, screenshots, and page interaction. Keep the viewport blank and neutral, with no website content. Premium macOS developer utility aesthetic, precise thin geometry with subtle material depth, teal #168F86 connection line, cool neutral surfaces, transparent background. No text, no logos, no globe cliché, no cloud, no people, no robot, no fake web page, no floating cards, no purple-blue glow.
```

### A08 Git 仓库未初始化

- **用途**：`GitRepositoryErrorState` 中“当前目录不是仓库”的可恢复状态。
- **目标文件**：
  - `public/visuals/empty-states/git-uninitialized-light.webp`
  - `public/visuals/empty-states/git-uninitialized-dark.webp`
- **画布**：1200 x 720，透明背景。
- **提示词**：

```text
Create a premium developer-tool empty-state illustration for a folder that is not yet a Git repository. Show a clean workspace folder plane with a source-control branch structure hovering just above it, ready to be anchored, with one subtle connection point highlighted. Communicate “initialize repository” rather than failure. Precise editorial technical illustration, sparse composition, cool silver and graphite materials, restrained teal #168F86 highlight, transparent background, readable at small size. No GitHub logo, no text, no fake command, no people, no robot, no warning triangle, no purple gradient, no decorative blobs.
```

### A09 本地服务启动失败

- **用途**：Electron launcher 的严重错误页，覆盖端口冲突、原生模块异常和后端未就绪。
- **目标文件**：
  - `public/visuals/errors/local-service-failed-light.webp`
  - `public/visuals/errors/local-service-failed-dark.webp`
- **画布**：1400 x 900。
- **构图**：右上或右侧主体，左侧/下方留出错误摘要与日志区域。
- **提示词**：

```text
Create a calm, professional recovery illustration for a macOS local developer service that failed to start. Show a compact local runtime core with one interrupted connection and a clearly visible repair junction, suggesting the system can diagnose and recover. The failure should feel contained and understandable, not catastrophic. High-end industrial editorial rendering, precise components, cool neutral materials, restrained red-orange fault indicator and teal #168F86 healthy paths. Leave generous empty space on the left and lower area for Chinese error text and logs. No explosion, no broken robot, no sad face, no cloud outage, no text, no readable code, no warning-sign cliché, no neon cyberpunk, no purple-blue gradient.
```

### A10 Agent CLI 未安装 / 未发现

- **用途**：用户截图中的 Claude Code “未安装”类错误，以及不同设备检测失败后的指引。
- **目标文件**：
  - `public/visuals/errors/agent-not-found-light.webp`
  - `public/visuals/errors/agent-not-found-dark.webp`
- **画布**：1200 x 720，透明背景。
- **提示词**：

```text
Create a compact recovery illustration for a local coding-agent executable that cannot be found on the current Mac. Show a local PATH route with one clearly empty executable socket and several alternate discovery routes around it, implying “install, locate, or rescan” rather than a dead end. Premium technical editorial style, clean and restrained, cool neutrals, one copper-orange missing-node marker, healthy route accents in teal #168F86, transparent background. No brand logos, no text, no command snippets, no magnifying glass, no people, no robot, no cloud, no red full-screen alarm, no purple gradient.
```

## 4. 第二优先级：推荐补齐（8 个场景，16 张浅深图）

### B01 文件树为空

- **目标文件**：`public/visuals/empty-states/files-empty-{light|dark}.webp`
- **尺寸**：960 x 600，透明背景。
- **提示词**：

```text
Minimal premium empty-state illustration for an empty developer workspace file tree: a precise folder structure with one open root and two faint placeholder branches, ready for files to appear. Compact, sparse, transparent background, cool silver and graphite, tiny teal #168F86 focus point, crisp at 240 pixels wide. No text, no file names, no people, no robot, no cloud, no decorative gradient.
```

### B02 会话归档为空

- **目标文件**：`public/visuals/empty-states/archive-empty-{light|dark}.webp`
- **尺寸**：960 x 600，透明背景。
- **提示词**：

```text
Compact editorial empty-state illustration for an empty archive of local coding sessions. Show a precise shallow archive tray with one subtle timeline rail passing above it, calm and unused, not dusty or nostalgic. Premium developer utility, restrained geometry, cool neutral materials, tiny teal accent, transparent background. No text, no cardboard box cliché, no people, no robot, no cloud, no purple gradient.
```

### B03 MCP 服务为空

- **目标文件**：`public/visuals/empty-states/mcp-empty-{light|dark}.webp`
- **尺寸**：960 x 600，透明背景。
- **提示词**：

```text
Create a compact technical empty-state illustration for no MCP tool servers configured. Show a local agent connector rail with several clean unoccupied ports and one add-ready port softly highlighted. Precise modular industrial design, premium macOS utility, cool silver and graphite palette, teal #168F86 active connector, transparent background. No text, no server rack, no cloud, no robot, no cables tangled, no neon, no purple gradient.
```

### B04 技能库为空

- **目标文件**：`public/visuals/empty-states/skills-empty-{light|dark}.webp`
- **尺寸**：960 x 600，透明背景。
- **提示词**：

```text
Create a refined empty-state illustration for a local coding-agent skill library with no skills installed. Depict a precise modular tool plate with a few empty fitted slots and one subtle insertion guide, implying reusable capabilities can be added. Editorial product design, restrained depth, cool neutral materials, teal #168F86 guide, transparent background. No text, no puzzle pieces, no magic wand, no brain, no robot, no cloud, no purple-blue glow.
```

### B05 对话审计暂无数据

- **目标文件**：`public/visuals/empty-states/audit-empty-{light|dark}.webp`
- **尺寸**：960 x 600，透明背景。
- **提示词**：

```text
Create a compact premium empty-state illustration for a coding-agent conversation audit before any activity exists. Show a clean local execution trace rail, an inactive permission checkpoint, and a small evidence ledger surface waiting for events. Technical editorial style, accurate hierarchy, cool neutrals, restrained teal #168F86 trace, transparent background. No text, no detective motif, no shield as the main object, no people, no robot, no cloud, no purple gradient.
```

### B06 更新完成

- **目标文件**：`public/visuals/brand/update-complete-{light|dark}.webp`
- **尺寸**：1000 x 700，透明背景。
- **提示词**：

```text
Create a compact premium illustration for a successfully updated macOS developer application. Show a precise local runtime core with a newly seated component and a clean circular continuity path, communicating a safe in-place update. Quiet and professional, no celebration. Brushed silver and graphite materials, teal #168F86 completion signal, tiny copper-orange version marker, transparent background. No text, no version number, no confetti, no gift box, no cloud download symbol, no robot, no purple gradient.
```

### B07 权限请求说明

- **目标文件**：`public/visuals/onboarding/local-permissions-{light|dark}.webp`
- **尺寸**：1200 x 800。
- **提示词**：

```text
Create an editorial technical illustration explaining local-only permissions for a coding-agent desktop app. Show a private workspace boundary around a Mac folder, terminal, browser, and Git branch, with each capability passing through a precise user-controlled checkpoint. The boundary remains entirely on the device; no external cloud connections. Premium, trustworthy, sparse macOS utility aesthetic, cool neutrals, teal #168F86 allowed paths, copper-orange checkpoint accents. No text, no giant shield, no padlock cliché as the main subject, no people, no robot, no cloud, no purple gradient.
```

### B08 LeoAPI 本地 Provider 路由

- **目标文件**：`public/visuals/onboarding/leoapi-routing-{light|dark}.webp`
- **尺寸**：1400 x 900。
- **提示词**：

```text
Create a premium technical illustration for a local API provider switcher inside a coding-agent desktop app. Show one clean local routing surface where several provider endpoints enter as distinct neutral channels, one active route is selected, tested for latency, and then directed into a local coding-agent command line. Emphasize clarity, switching, model discovery, and speed measurement without showing any provider logos or API keys. Precise editorial industrial style, cool neutral palette, teal #168F86 active route, copper-orange latency pulse, no text, no readable URLs, no cloud dashboard, no robot, no tangled network, no purple-blue gradient.
```

## 5. 第三优先级：Agent 抽象标识套件（7 张透明资产）

现有 Agent Logo 多数应继续使用各产品官方图形或当前代码图标。为了避免授权和品牌混乱，可以补一套 **leocodebox 自有抽象状态标识**，用于“未识别 Agent”、自动探测结果和功能介绍，而不是伪造第三方 Logo。

- **保存目录**：`public/visuals/agents/`
- **文件**：
  - `agent-terminal.png`
  - `agent-editor.png`
  - `agent-browser.png`
  - `agent-review.png`
  - `agent-planner.png`
  - `agent-research.png`
  - `agent-generic.png`
- **尺寸**：每张 1024 x 1024，透明背景；最终导出 256 x 256 WebP。
- **统一提示词模板**：

```text
Design one icon from a coherent seven-icon system for leocodebox, a premium local coding-agent macOS app. Subject: [TERMINAL / EDITOR / BROWSER / REVIEW / PLANNER / RESEARCH / GENERIC LOCAL AGENT]. Build the symbol from precise machined geometric parts with a subtle radial signal motif derived from a local command cursor. Front-facing three-quarter product-icon perspective, compact silhouette, highly recognizable at 32 pixels, brushed graphite and silver materials, one restrained teal #168F86 active element, optional tiny copper-orange #D9784A detail. Transparent background, centered with 14 percent safe margin. No text, no letters, no company logo, no face, no humanoid robot, no brain, no cloud, no excessive gloss, no purple-blue gradient, no drop shadow outside the icon. Keep identical lighting, camera angle, material language, and visual weight across all seven icons.
```

生成时仅替换方括号内主题，并固定同一 seed、镜头、材质和光照。

## 6. 发布和 GitHub 展示资产（6 张，不直接进入高频 UI）

### C01 GitHub README 主视觉

- **目标文件**：`public/visuals/release/readme-hero.webp`
- **尺寸**：2400 x 1260（约 1.91:1，兼容社交预览裁切）。
- **提示词**：

```text
Create a premium product hero image for leocodebox, a local macOS workspace for controlling coding-agent CLIs. Show a real, inspectable product composition rather than an atmospheric poster: a crisp macOS desktop workspace at the center with chat, terminal, files, source control, browser automation, and local agent status arranged as one coherent professional tool. Surround it with subtle physical cues of local execution and multiple agent channels, but keep the actual interface area clean enough to composite a real screenshot later. Cold silver, white, graphite, restrained teal #168F86 and copper-orange #D9784A. Editorial Apple-quality product photography and industrial rendering, sharp and bright, no dark blur, no people, no robot, no cloud, no fake readable UI text, no purple gradient. Reserve a quiet upper-left area for the real leocodebox wordmark added later. 1.91:1 horizontal.
```

建议：模型只生成背景与设备场景，后期由设计工具嵌入真实产品截图，不能让模型伪造 UI。

### C02 DMG 安装窗口背景

- **目标文件**：`electron/assets/dmg-background.png`
- **尺寸**：1320 x 800（2x，实际显示 660 x 400）。
- **提示词**：

```text
Create a minimal premium macOS DMG installer background for leocodebox. Quiet cold-white or graphite surface with a subtle machined local-runtime motif framing the far edges, leaving the center completely clean for the app icon, Applications folder icon, and arrow added by the installer. Restrained teal #168F86 micro-accent, precise Apple-quality material, no text, no logos, no icons, no arrows, no buttons, no gradients, no bokeh, no visual clutter. 1320 by 800 pixels.
```

需要浅色和深色候选各一张，最终 DMG 只选对比最清楚的一张。

### C03 Release 功能总览图

- **目标文件**：`public/visuals/release/feature-overview.webp`
- **尺寸**：2400 x 1500。
- **提示词**：

```text
Create a clean premium release visual for a macOS local coding-agent workspace. Compose one central Mac workspace surrounded by six precise capability zones: agent chat, terminal, files, Git, browser control, and local API switching. The zones must read through abstract physical motifs, not fake screenshots or floating cards. Editorial technical product visualization, structured and highly legible, cold silver and graphite neutrals, teal #168F86 active paths, tiny copper-orange accents, no text, no logos, no people, no robots, no cloud infrastructure, no neon, no purple gradient. Wide 16:10 composition with room for real labels added later.
```

### C04 多设备本地发现图

- **目标文件**：`public/visuals/release/multi-device-local-discovery.webp`
- **尺寸**：2400 x 1500。
- **提示词**：

```text
Create a premium editorial technical visualization showing leocodebox installed on three different Macs, with each device independently discovering its own locally installed coding-agent CLIs and workspace paths. No cloud synchronization and no shared remote server: each machine has a self-contained discovery map with different executable locations, all expressed in one consistent product language. Bright, inspectable, precise, cold silver and graphite palette, teal #168F86 discovery signals, copper-orange local markers, no text, no company logos, no people, no robot, no cloud, no fake UI, no purple-blue gradient. 16:10 horizontal.
```

### C05 LeoAPI 功能图

- **目标文件**：`public/visuals/release/leoapi-overview.webp`
- **尺寸**：2400 x 1500。
- **提示词**：沿用 B08，但增加 `wide release composition, room for real Chinese labels added later`。

### C06 安全与本地权限图

- **目标文件**：`public/visuals/release/local-security.webp`
- **尺寸**：2400 x 1500。
- **提示词**：沿用 B07，但增加 `show all data paths terminating inside the physical device boundary`。

## 7. 微纹理资产（可选，4 张）

纹理只能作为 2%-5% 不透明度的局部背景，不可成为视觉主角。

- `public/visuals/textures/cold-metal-light.webp`
- `public/visuals/textures/graphite-dark.webp`
- `public/visuals/textures/local-signal-light.webp`
- `public/visuals/textures/local-signal-dark.webp`
- 尺寸：2048 x 2048，可无缝平铺。
- **提示词**：

```text
Generate a seamless ultra-subtle premium surface texture for a macOS developer application background: [cold silver micro-grain / graphite micro-grain / sparse local signal topology]. Almost flat, extremely low contrast, no focal point, no objects, no text, no scratches, no paper fibers, no noise speckles, no gradients, no bokeh. Designed to be overlaid at 2 to 5 percent opacity without reducing text readability. Seamless 2048 by 2048 tile, sRGB.
```

## 8. 不应使用生图的区域

以下区域应使用真实 UI、Lucide 图标、CSS 状态或数据可视化，不要生成位图：

1. 聊天消息正文、工具调用、权限确认、Token 使用量。
2. 终端、网页终端和命令输出。
3. 文件树、代码编辑器、Markdown 预览。
4. Git changes、diff、branch 和 history。
5. LeoAPI Provider 列表、API Key、模型测速结果。
6. 全局设置、切换器、表单、开关、菜单和返回按钮。
7. Agent 官方 Logo。官方品牌应使用合法的官方资产或当前代码图标，不能由模型“仿制”。
8. 图表、延迟数据、项目统计。必须使用真实数据绘制。
9. 错误日志。日志必须可复制、可搜索、可读，不能烘焙进图片。

## 9. 批量生成顺序

建议按以下批次执行，以便先校准风格再扩量：

1. **风格校准批**：A01、A02、A05，各生成 4 个候选，只选出一套统一材质和光照。
2. **关键流程批**：A03、A04、A06、A07、A08、A09、A10。
3. **空状态批**：B01-B05。
4. **功能解释批**：B07、B08。
5. **品牌发布批**：C01-C06。
6. **图标批**：Agent 7 图标，必须固定 seed 和镜头。
7. **纹理批**：只有当前几批落地后仍显得过空，才生成纹理。

## 10. 每张图的验收清单

- [ ] 浅色和深色版构图一致，材质分别适配主题。
- [ ] 没有任何模型生成的乱码、代码、按钮或品牌 Logo。
- [ ] 主体缩到目标显示尺寸后仍能辨认。
- [ ] 文案安全区没有高对比细节。
- [ ] 没有紫蓝 AI 渐变、机器人、脑形、云端或泛滥光晕。
- [ ] 色彩只使用冷中性 + 青绿主色 + 极少铜橙。
- [ ] 透明边缘干净，无黑边、白边和毛刺。
- [ ] 画面在浅色和深色 UI 中都通过对比度检查。
- [ ] 图片只承担解释或品牌功能，不遮挡高频操作。
- [ ] 最终文件名与本文档路径完全一致。

## 11. 预计资产数量

| 级别 | 场景 | 文件数 |
|---|---:|---:|
| 必须 | 10 个浅深场景 | 20 |
| 推荐 | 8 个浅深场景 | 16 |
| Agent 抽象图标 | 7 个透明图标 | 7 |
| 发布展示 | 6 个场景（部分仅单版） | 8-10 |
| 微纹理 | 4 个 | 4 |
| **总计** | **35 个视觉主题** | **55-57 个最终文件** |

第一轮不必一次生成全部。优先交付 A01、A02、A03、A04、A05、A06、A09、A10 共 16 张浅深图，我可以先完成前端接入和实际窗口验收，再决定剩余资产是否需要调整。
