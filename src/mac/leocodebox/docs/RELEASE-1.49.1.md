# leocodebox 1.49.1

修复版:补掉 1.49.0 接入 grok 时暴露的两个严重回归,并补齐 grok 在各处的运行时白名单缺口。两处 bug 均在隔离环境真机浏览器里复现并验证修复。

## 修了什么

**[严重] 新建对话所有模型都看不到(每个 CLI 都「未找到模型」)**
- 根因:后端 `parseProvider` 的 provider 白名单硬编码,漏了 `grok` → `/api/providers/grok/models`(以及 auth/status、active-model)一律 **400** → 前端 `loadProviderModels` 的 `Promise.all` 因这一个 reject 整体失败 → **所有 provider 的模型目录一起被清空**。
- 修复:白名单补上 grok;并把每个 provider 的拉取**各自 try/catch 隔离**——任何单个 provider 报错都不再连累其余(防同类问题复发)。
- 验证:5 个 provider 的 `/models` 全部 200(claude 7 / cursor 107 / codex 5 / opencode 6 / grok 2)。

**[严重] 智能体档案「新建」弹窗看不到**
- 根因:设置模态是 `z-[9999]`,而共享 `Dialog` 组件是 `z-50`——从设置内部打开的档案编辑弹窗虽已挂载到 DOM,却被设置模态**盖在下面**,看起来像「点了没反应」。
- 修复:共享 `Dialog` 抬到 `z-[10000]`(与已有的 MCP、技能弹窗一致的层级),从设置里打开的任何弹窗都能正确浮在最上层。
- 验证:浏览器里点「新建」→ 档案编辑弹窗正常浮现在设置之上。

**grok 一等化补齐(让「全能力使用」名副其实)**
- `CLI_PROVIDERS` 补 grok:设置里 grok 的登录/状态会真正刷新。
- 智能体档案 DB 白名单补 grok:grok 档案不再被静默改写成 claude(附回归单测)。
- 偏好 `defaultProvider` 校验、`/api/agent` 无头执行分支补 grok(mirror opencode,走 spawnGrok)。

## 附带

- `docs/VISUAL-REFRESH-PROMPTS.md`:一份把现有「3D 实景工作台照」换成极简高级抽象编辑风的**生图 prompt 清单**(全局风格系统 + 调色板锁定产品主色 teal-emerald + 逐图 prompt + 一致性清单),供出图管线直接取用。

## 验证

- ESLint 0 警告,客户端与服务端 TypeScript 检查通过,生产构建通过。
- 自动测试:desktop 27、client 65、server 261(新增 grok 档案保真单测),共 353 全绿。
- 隔离环境真机浏览器复验:两处 bug 均复现原状并确认修复(bug#1 五 provider `/models` 全 200;bug#2 新建弹窗浮现)。

## 下载校验

- DMG SHA-256:`73d8a20581cedb267b8cab2b727b23d0c0600836a717df3173501887acd5e1ea`
- ZIP SHA-256:`1ea36293151b4af696f921f65290ce3ec8c921122fe20375a015fe26253635e6`
- `latest-mac.yml` SHA-256:`d7363b4d7776466f72fa077fae4c5cce70de59640de509b1066e0e45ae8f02ba`
