# LeoPhoneAgent · Mac

![leocodebox 本地 Agent 工作台](public/visuals/release/readme-hero.webp)

![version](https://img.shields.io/badge/source-1.80.0-blue)
![platform](https://img.shields.io/badge/platform-macOS%20arm64-lightgrey)
![signed](https://img.shields.io/badge/signed-Developer%20ID-blue)
![license](https://img.shields.io/badge/license-AGPL--3.0-orange)

**LeoPhoneAgent · Mac** 是 LeoPhoneAgent 的本地优先 macOS 工作台，用一个界面统一管理本机的 AI 编码 Agent CLI，并作为 iPhone / iPad 的 Mac 端能力入口。内部应用标识 `leocodebox` 为兼容既有安装与自动更新而保留。

> 源码已并入 [LeoPhoneAgent 主仓库](https://github.com/leoyb1010/LeoPhoneAgent/tree/main/src/mac/leocodebox)。`leocodebox-updates` 仅承载签名更新产物，不承载源码或 Issue。

> English: leocodebox is a local-only macOS desktop app that unifies the management of local coding-agent CLIs (Claude Code, Codex, Cursor, OpenCode, Grok Build) — projects, sessions, skills, MCP servers, and provider configuration — with no cloud account required.

## ⬇️ 下载

[![下载 DMG](https://img.shields.io/badge/下载-LeoPhoneAgent%20Mac%201.80.0%20(arm64)-brightgreen?style=for-the-badge)](https://github.com/leoyb1010/leocodebox-updates/releases/latest)

- **最新版本**：<https://github.com/leoyb1010/leocodebox-updates/releases/latest>
- **当前源码版本**：`1.80.0`
- **当前公开可安装版**：`1.80.0`
- **源码**：<https://github.com/leoyb1010/LeoPhoneAgent/tree/main/src/mac/leocodebox>
- **Issues**：<https://github.com/leoyb1010/LeoPhoneAgent/issues>

1.80.0 已用本机 `Developer ID Application: leo yuan (48H5Y3LNUK)` 签名，并发布到 `leocodebox-updates`（`v1.80.0` + `latest-mac.yml`）。公证钥匙串 profile `leocodebox` 本机不在，所以没有 stapler 钉章；热更新继续走同一 TeamIdentifier 的签名链。补公证：`xcrun notarytool store-credentials` 后跑 `npm run desktop:notarize:mac`。

---

## ✨ 特性

- **本地优先，无 leocodebox 云端依赖**：打开 App 自动在 `127.0.0.1:38473` 启动本地服务，退出即停止并释放端口。项目索引、会话索引和工作台配置保存在本机。
- **多智能体统一管理**：在一个界面里管理 Claude Code / Codex / Cursor / OpenCode 的认证、模型、权限模式、会话、技能和 MCP，并集中检查 Gemini CLI、Hermes 与 Grok Build。
- **智能体档案 Hub**：把常用的「CLI + 模型 + 努力度 + 权限模式 + 开场提示词」存成命名档案,一键启动预配置好的新对话;支持编辑/复制/删除与 JSON 导入导出,让工作台成为你的个人智能体集合。
- **MCP / 技能一等管理与安全网**：MCP 与技能升为设置顶层 Tab;MCP 全景板可按 CLI 一键装/卸(传输不兼容自动置灰),技能一键软删除并可在回收站找回;安装技能前静态扫描 prompt 注入 / 硬编码密钥 / 数据外泄 / 危险命令,高危阻断需二次确认。
- **环境体检 Doctor**：状态栏健康灯一眼看出各 CLI 装没装 / 能不能跑、Leoapi 节点配没配 / 最近测速通不通(全绿 / 琥珀 / 红),⌘K 亦可直达逐项检查单。
- **跨设备发现本机 CLI**：从登录 Shell 和 npm、Homebrew、Volta、nvm、mise、asdf、fnm、bun、pnpm、yarn 等常见安装位置合并运行路径；支持 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`OPENCODE_CONFIG_DIR`、`OPENCODE_DATA_DIR` 与 XDG 自定义目录。
- **实时 CLI 版本与安全更新**：识别 npm、Homebrew、pnpm、Volta、Bun 和官方独立安装器；支持逐个或批量更新，无法自动更新时提供可复制的安全命令，不会误装第二份 CLI。
- **模型列表自动跟随 CLI**：模型目录随本机 CLI 更新自动刷新（例如 Codex 升级后自动出现新一代模型），带源文件指纹失效机制。
- **Leoapi 接口切换**：接口配置切换器内置在应用内（不跳外部 App），支持多个请求地址、自动选择最快可用地址、模型列表读取、真实模型测速、Claude Sonnet/Opus/Haiku 映射、备份恢复，并可从旧切换器数据库（`~/.cc-switch/cc-switch.db`）一键导入。
- **项目按 Agent 分类**：侧边栏项目列表按 Claude / Codex / OpenCode / Cursor / Gemini 显示彩色会话计数徽章，并过滤一次性/临时目录，只留真实项目。
- **简体中文默认**，深色/浅色/跟随系统主题。
- **桌面模式完全免登录**：本地能力 token 由 Electron 自动注入，只允许本机应用访问；从 App 打开浏览器时使用两分钟、单次有效的临时授权链接，不显示 leocodebox 账号密码页。
- **内置浏览器运行环境**：正式包自带 Playwright headless Chromium，安装后可直接交给 Agent 使用；修复运行环境只写入 `~/.leocodebox/runtime`，不会修改已签名 App。
- **应用内热更新**：1.39.1 起默认使用公开签名资产源，在“设置 → 关于”即可检查、下载并重启安装，无需 GitHub Token；源码仓库仍保持私有。
- **签名发布、公证就绪**：当前 DMG 已做 Apple Developer ID 签名；配置 notarytool profile 后可走同一发布脚本补 Apple 公证与 stapler 钉章。

## 🖥️ 支持的 Agent

| Agent | 说明 | 认证方式 |
|---|---|---|
| **Claude Code** | Anthropic 官方 CLI | `claude /login` / API Key / settings.json |
| **Codex** | OpenAI Codex CLI | ChatGPT 登录 / `OPENAI_API_KEY` |
| **Cursor** | Cursor Agent CLI | `cursor-agent login` |
| **OpenCode** | OpenCode CLI | OAuth / Provider API Key |
| **Gemini CLI** | Google Gemini CLI | Google 登录 / API Key |
| **Hermes** | Nous Research Hermes Agent | 本机 CLI 配置 |
| **Grok Build** | xAI Grok Build TUI | 本机 `grok` 配置 |

> Agent CLI 本身不打包在应用内。每台 Mac 安装 leocodebox 后，应用会检测并驱动该设备上已安装的 CLI；Agent 的登录与网络请求仍直接连接各自服务商。

## 🏗️ 架构

```
┌─────────────────────────────────────────────┐
│  Electron 外壳 (electron/)                    │
│  · 启动台 launcher + 多 Tab (BrowserView)     │
│  · 生命周期：启动拉起服务 / 退出停止服务         │
└───────────────┬─────────────────────────────┘
                │ 本地 HTTP 127.0.0.1:38473
┌───────────────▼─────────────────────────────┐
│  本地服务 (server/) — Node + Express          │
│  · Providers / Projects / Sessions / MCP      │
│  · 技能 / 代码仓库 / Leoapi / 本地接口        │
│  · SQLite  ~/.leocodebox/auth.db               │
└───────────────┬─────────────────────────────┘
                │ 静态托管
┌───────────────▼─────────────────────────────┐
│  前端 (src/ → dist/) — React + Vite           │
│  · Tailwind + shadcn/ui · react-i18next        │
│  · CodeMirror 编辑器 · xterm 终端              │
└─────────────────────────────────────────────┘
```

- **技术栈**：Electron · Node/Express · SQLite(better-sqlite3) · React 18 · Vite · TypeScript · Tailwind CSS · react-i18next
- **平台**：macOS **arm64**（Apple 芯片）

## 📦 安装

从 Releases 下载 Developer ID 已签名的 DMG（macOS Apple 芯片；1.80.0 尚未公证）：

1. 双击 DMG，把 **leocodebox** 拖入「应用程序」。
2. 双击运行；1.80.0 尚未公证，首次打开如遇 Gatekeeper 提示，请在“系统设置 → 隐私与安全性”确认打开，不要用 `xattr` 全局移除隔离。
3. 首次打开自动启动本地服务，直接进入界面。

## 🔧 从源码构建

```bash
# 依赖
npm install

# 开发（前端 + 服务并行）
npm run dev

# 桌面开发（一条命令启动 Electron ABI 后端、Vite 与桌面壳）
npm run desktop:dev

# 完整构建（前端 + 服务）
npm run build

# 打包桌面 DMG（自用 adhoc 签名）
npm run desktop:dist:mac
```

质量检查：`npm run typecheck` · `npm run lint`

> `desktop:dev` 会自动用 Electron 的 Node 启动服务端，并统一本地端口与开发令牌，避免 `38473` 未就绪或原生模块 ABI 不一致。

## 🖊️ 签名与公证（对外分发）

要产出别人下载双击即可运行的 DMG，需要 Apple Developer ID 证书 + 公证。完整步骤见 **[docs/SIGNING.md](docs/SIGNING.md)**：

```bash
# 一次性：Xcode 创建 Developer ID Application 证书 + 存公证凭据
xcrun notarytool store-credentials leocodebox --apple-id <id> --team-id <TEAMID> --password <app专用密码>

# 每次出正式版
export LEOCODEBOX_SIGN_IDENTITY="Developer ID Application: <名字> (<TEAMID>)"
npm run desktop:dist:mac:signed     # 签名并打包 DMG
npm run desktop:notarize:mac        # 提交 Apple 公证 + 钉章
```

## 📁 项目结构

```
electron/        Electron 主进程、启动台、窗口/Tab 管理、本地服务生命周期
server/          本地 Node/Express 服务：providers / projects / sessions / mcp / git / Leoapi
src/             React 前端（组件、hooks、i18n、状态）
shared/          前后端共享工具
build/           签名 entitlements
scripts/release/ 构建、暂存、签名、公证脚本
docs/            SIGNING.md 等文档
dist/ dist-server/  构建产物（不入库）
```

## 🔒 本地与隐私

- 服务绑定 `127.0.0.1`，桌面模式用每次启动生成的本地能力 token。
- leocodebox 云账号和托管 Agent 环境在本构建中禁用；应用更新仅在用户主动配置 GitHub 凭据或通用更新源后启用。
- 智能体凭据保留在各命令行工具的本机配置目录；Leoapi 数据以 `0700/0600` 权限保存在 `~/.leocodebox/switch/`，应用更新凭据由 macOS 钥匙串加密。

## 📄 许可与归属

leocodebox 以 **AGPL-3.0-or-later** 分发。

本项目基于 CloudCLI UI（`https://github.com/siteboon/claudecodeui`），并在 `LICENSE` 与 `NOTICE` 中保留所需的法律声明与第三方归属。请勿移除这些声明。

### CodexHost 原生 Harness 模式

1.83.0 起随包内置 [CodexHost 0.4.4](https://github.com/BytePioneer-AI/codex-host) 的官方完整载荷；
1.80.0 起主控台直接显示独立 CodexHost 工作台卡片。点「打开 CodexHost」，即可在 Codex Desktop 中使用 Pi、
Oh My Pi、Claude Code、Grok Build 与 DeepSeek Harness；流式输出、工具状态、Diff、审批、
Usage、Fork、上下文压缩和斜杠命令由各 Harness 原生适配器投影，不退化成通用聊天协议。

CodexHost 与本工作台职责分离：它增强 Codex Desktop；LeoAPI、本机 Provider、手机中继、
Fleet 与热更新仍由 leocodebox 提供。随包版本固定并参与构建/测试，用户无需额外全局安装。
