# leocodebox 配图刷新 · 生图 Prompt 清单

目标:把现在这套「3D 实景工作台/桌面照」换成**极简、高级、洋气**的抽象编辑风视觉。
方向参考:Linear / Vercel / Stripe / Raycast 级别的品牌极简 —— 大留白、单一主色、克制几何、柔和体积光,带一点温度与胶片颗粒,**不出现**真实办公室/桌子/笔记本/人手/键盘特写。

下面每条都能直接投喂给你的生图管线(Midjourney / Flux / SDXL / Nano-Banana 等)。先看**全局风格系统**(所有图共用),再按分组取每张的**场景 prompt**。

---

## 0. 全局风格系统(每条 prompt 都拼上这段)

**STYLE BLOCK(建议置于每条 prompt 结尾):**
> minimalist editorial tech illustration, abstract geometric composition, generous negative space, one calm focal subject, soft volumetric studio light, ultra-clean, premium and understated, subtle film grain, gentle depth of field, matte finish, no text, no logos, no people, no hands, no realistic office desk, no laptop photo, no stock-photo look —— high-end brand key visual.

**调色板(严格锁定,呼应产品主色 teal-emerald,hue 174):**
- 主色 Primary:`#149487`(深 teal-emerald) → 高光可到 `#33C6B2`
- 浅色底 Light neutral:`#F6F7F5` 暖白 / `#ECEEEA` 微灰,阴影 `#D8DBD6`
- 深色底 Graphite:`#0E1113` / `#14181B`,层次 `#1C2226`
- 金属中性点缀:`#9AA3A0` 冷灰 / 极少量 `#C9CFCC`
- **只允许一个主色**(teal-emerald),其余全部中性。禁止多彩、禁止蓝紫渐变堆叠。

**光与质感:** 单一柔和主光(左上或正上),长而软的阴影;哑光陶瓷/磨砂玻璃/阳极氧化铝质感;极细(1px 感)几何线;可选极淡等距网格或点阵作为背景纹理。

**统一负面 prompt(NEGATIVE,所有图通用):**
> realistic photo, office desk, laptop, keyboard closeup, human, hands, face, cluttered, busy background, rainbow gradient, neon cyberpunk, glossy 3D render toy look, lens flare overload, watermark, text, ui screenshot, low-contrast mud, stocky corporate clipart.

**技术规格:**
- 每张出 **light / dark 两版**(除营销大图另注)。dark 版把暖白底换 graphite 底、主色提亮到 `#33C6B2`。
- 导出 `webp`,质量 ~82,尺寸见每条。命名沿用现有路径覆盖即可(见每条 `→ 覆盖`)。
- 构图**左/中留白**,因为 UI 会在图上叠标题文字;主体偏右或居中偏下。

---

## 1. Onboarding(引导图,4 组 × light/dark,**1536×1024**,3:2)

在 UI 里以 `aspect-[16/10] object-cover` 裁切显示,所以**上下留安全边**。

### 1.1 `local-workbench`(首屏「选择您的项目」——最显眼,优先做)
概念:「本地即工作台」。抽象一台悬浮的哑光陶瓷「工作台面」,台面上是极简的几何编码符号(一个 teal 的 `{ }` 或流线),周围是漂浮的细线连接点,象征本机 Agent 汇聚。**不要真实桌子**。
> a single floating matte-ceramic slab hovering in soft studio light, one teal-emerald abstract code glyph resting on it, thin geometric connector lines converging from empty space, calm and premium, lots of negative space on the left, 3:2 — [STYLE BLOCK]
`→ 覆盖 public/visuals/onboarding/local-workbench-{light,dark}.webp`

### 1.2 `cli-discovery`(发现本机 CLI)
概念:「自动发现」。几枚哑光圆形「节点」从雾中依次点亮,由虚到实,一条极细 teal 轨迹把它们串起;象征扫描 PATH 找到各个 CLI。
> a row of matte spheres emerging from soft fog, lighting up left-to-right, one thin teal-emerald trace linking them, minimal, floating, generous negative space, 3:2 — [STYLE BLOCK]
`→ 覆盖 public/visuals/onboarding/cli-discovery-{light,dark}.webp`

### 1.3 `local-permissions`(本地权限/安全)
概念:「本地即安全」。一枚极简的哑光「盾」几何体或一个闭合的 teal 环包住一个中性核心,柔光,克制;传达数据留在本机。
> a minimal matte shield-like geometric form, or a closed teal-emerald ring enclosing a soft neutral core, quiet and secure feeling, soft top light, 3:2 — [STYLE BLOCK]
`→ 覆盖 public/visuals/onboarding/local-permissions-{light,dark}.webp`

### 1.4 `leoapi-routing`(接口路由/切换)
概念:「优雅路由」。一个 teal 节点通过几条平滑贝塞尔曲线分流到多个中性端点,只有当前活跃那条是 teal 实线,其余是浅灰虚线;传达节点切换/故障转移。
> one teal-emerald source node routing smooth bezier curves to several neutral endpoints, only the active path is a solid teal line, others faint grey, elegant flow, minimal, 3:2 — [STYLE BLOCK]
`→ 覆盖 public/visuals/onboarding/leoapi-routing-{light,dark}.webp`

---

## 2. 营销 / Release 大图(**3840×2160**,16:9,单版即可,默认深色更高级)

### 2.1 `readme-hero`(README / 官网主视觉)
概念:产品级 hero。中央一枚悬浮的哑光「L」品牌几何体(或抽象 `{ }`),被极细的等距连接网从四周温柔汇聚,单一 teal 焦点辉光,极大留白,电影感柔光。
> hero brand key visual: a single floating matte monolithic form (abstract bracket or minimal L-mark) at center, ultra-fine isometric connection web converging softly, one teal-emerald focal glow, cinematic soft light, vast negative space, premium and quiet, 16:9 — [STYLE BLOCK]
`→ 覆盖 public/visuals/release/readme-hero.webp`

### 2.2 `feature-overview`(能力总览)
概念:三到四枚哑光几何「卡片」在深空间里错落悬浮,每枚有一个极简 teal 图元(对话/技能/MCP/权限),统一光,不写字。
> three or four matte geometric cards floating at staggered depth in a dark studio void, each holding one minimal teal-emerald icon-glyph, unified soft light, elegant, 16:9 — [STYLE BLOCK]
`→ 覆盖 public/visuals/release/feature-overview.webp`

### 2.3 `leoapi-overview`(接口/网关总览)
概念:2.4 的营销大图版 —— 一个 teal 中枢,平滑曲线分流到一圈中性端点,活跃路径高亮,背景极淡点阵。
> a central teal-emerald hub distributing smooth flowing curves to a ring of neutral endpoints, active route highlighted, faint dot-grid backdrop, dark premium space, 16:9 — [STYLE BLOCK]
`→ 覆盖 public/visuals/release/leoapi-overview.webp`

### 2.4 `local-security`(本地安全)
概念:一枚哑光实心几何体被一层半透磨砂玻璃「壳」包裹,teal 描边,象征本机隔离;冷静、克制、无锁具象。
> a matte solid form wrapped in a translucent frosted-glass shell with a thin teal-emerald edge, sense of local isolation and safety, no literal lock, cool and quiet, 16:9 — [STYLE BLOCK]
`→ 覆盖 public/visuals/release/local-security.webp`

### 2.5 `multi-device-local-discovery`(多设备本机发现)
概念:两三枚相同的哑光「设备石」在留白中隔空,用极细 teal 弧线各自独立发光(强调「都在本机、不上云」),不要真实手机/电脑。
> two or three identical matte monolith "device stones" spaced across negative space, each glowing independently via a thin teal-emerald arc, emphasising local-only, no real phone or computer, minimal, 16:9 — [STYLE BLOCK]
`→ 覆盖 public/visuals/release/multi-device-local-discovery.webp`

---

## 3. 空状态 Empty-states(**1536×1024**,light/dark;按需挑做,风格同上但更「安静」)

统一概念:每个空状态 = 一个**单一极简符号** + 大留白,传达「这里还空着、等你开始」。全部用主色 teal 做唯一点缀,其余中性。建议尺寸 1536×1024 或按现图。

| 文件(覆盖) | 概念 prompt(拼 STYLE BLOCK) |
|---|---|
| `empty-states/new-session-*` | a single soft teal-emerald spark/seed floating in vast neutral space, ready-to-begin feeling |
| `empty-states/workspace-unselected-*` | a minimal empty matte frame/portal in the center, one faint teal edge, inviting |
| `empty-states/files-empty-*` | a few floating blank matte sheets, gently fanned, one teal corner |
| `empty-states/mcp-empty-*` | one unlit socket-like matte node with a faint teal ring, waiting to connect |
| `empty-states/skills-empty-*` | a single matte facet/gem outline with a soft teal glint, potential |
| `empty-states/tasks-empty-*` | a clean matte checklist abstracted to three floating lines, top line teal |
| `empty-states/git-uninitialized-*` | a single branching line splitting once, node in teal, calm |
| `empty-states/browser-idle-*` | a minimal rounded matte viewport shape, dim, one teal dot |
| `empty-states/audit-empty-*` | a soft magnifier-abstraction (teal ring + neutral handle line), quiet |
| `empty-states/archive-empty-*` | a matte drawer/box abstract, slightly open, faint teal inner light |

## 4. 错误 / 品牌(可选,同系统)

| 文件(覆盖) | 概念 prompt(拼 STYLE BLOCK) |
|---|---|
| `errors/agent-not-found-*` | a faint dotted outline where a matte node should be, one teal question-arc, gentle not alarming |
| `errors/local-service-failed-*` | a matte node with a single soft teal pulse fading, calm recovery mood, not red/aggressive |
| `brand/launch-*` | the hero monolith mid-rise with a soft teal dawn glow, welcoming |
| `brand/update-complete-*` | the monolith settled, one clean teal check-arc completing, satisfying and quiet |

---

## 5. 一致性检查清单(出图后自查)
- [ ] 只有一个主色(teal-emerald),没有第二个饱和色
- [ ] 没有真实桌子/笔记本/人/手/文字/UI 截图
- [ ] 大留白,主体不塞满;左或中留白给标题
- [ ] light 版暖白底、dark 版 graphite 底,成对
- [ ] 哑光/磨砂质感,柔和单光源,极细线,统一到像同一套
- [ ] 导出 webp,覆盖同名路径;`onboarding/*` 3:2、`release/*` 16:9

> 备注:现有 `.png` 是 `.webp` 的回退,若同时存在建议一并更新或删除 png 回退以免风格不一。
