# leocodebox 视觉资产融合清单

更新时间：2026-07-12

## 统计口径

- `public/visuals` 的 83 个文件并不等于 83 个独立画面，其中包含浅/深色版本以及 PNG/WebP 重复导出。
- 实际为 35 个视觉主题。
- 产品以 WebP 为运行时资源，PNG 保留为母版或发布源文件，不重复渲染。

## 已接入

| 主题 | 使用位置 | 状态 |
| --- | --- | --- |
| `launch-light/dark` | Electron 本地服务启动页 | 已接入 |
| `local-workbench-light/dark` | 首次引导、工作台无会话状态 | 已接入 |
| `cli-discovery-light/dark` | 首次引导的本机 CLI 检测步骤 | 已接入 |
| `leoapi-overview` | Leoapi 无接口状态、浏览器空状态视觉 | 已接入 |
| `local-security` | 设置 > 关于，本地数据说明 | 已接入 |
| `update-complete-light/dark` | 设置 > 关于，更新下载完成状态 | 已接入 |
| `readme-hero` | GitHub README 首屏 | 已接入 |
| `dmg-background-light` | macOS DMG Finder 安装窗口 | 已接入 |

## 保留用于发布

| 主题 | 用途 |
| --- | --- |
| `feature-overview` | GitHub Release 功能概览 |
| `multi-device-local-discovery` | GitHub Release 多设备本机发现说明 |
| `cold-metal-light` / `graphite-dark` | 发布图和文档背景，不铺进高频操作区 |
| `local-signal-light/dark` | 发布图和品牌动效底纹 |
| `dmg-background-dark` | DMG 深色候选源文件；Finder 安装窗口使用稳定的浅色版本 |

## 暂不接入：源资产需返工

以下主题的所谓透明背景已经被灰白棋盘格烘焙进图片，`hasAlpha=no`。在浅色和深色界面中都会出现明显方格底，不能达到正式产品质量：

- `empty-states` 全部 10 组：工作区、会话、文件、任务、浏览器、Git、MCP、技能、归档、审计。
- `agents` 全部 7 组：通用、规划、编辑、终端、浏览、研究、审查。
- `errors/agent-not-found` 浅色与深色版本。

返工要求：真正透明 PNG（必须包含 Alpha 通道）、边缘无白边，再导出 WebP；不要在图片中绘制透明棋盘格。

`errors/local-service-failed` 保留给 Electron 启动失败页的下一轮结构调整，当前启动页需要优先显示可复制的诊断日志，不能让大图挤压错误信息。

## 图标统一

Leoapi 不再把 Agent 映射到 Activity、JSON、Server、Play 等无关通用图标。Claude Code、Codex、Gemini CLI、OpenCode、Cursor、Hermes Agent 均使用本地离线 Provider 标识，并与工作台的颜色和语义一致。

## 验收原则

1. 高频操作区不铺大面积装饰图。
2. 空状态图片不能挤压主操作，也不能造成滚动跳动。
3. 浅色、深色、跟随系统三种主题均需验证。
4. 所有图片必须随 DMG 离线打包，不依赖远端 URL。
5. 不以“使用文件数量”为目标，以清晰、统一和真实可用为目标。
