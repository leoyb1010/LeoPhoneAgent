# Workspace 2.0 升级完成度审计

> **文档状态（2026-07-12 标注）**：过程性状态页，部分声明已过期——
> README 下载入口现指向最新正式版（非 1.37.0）；后续以 docs/RELEASE-1.4x 系列与本仓库 CHANGELOG 为准。


> 审计日期：2026-07-11（Asia/Shanghai）
> 原始执行文档：`/Users/admin/Desktop/leocodebox-审查与升级执行文档-2026-07-11.md`
> 原始接手线程：`019f5103-a6d7-7750-8f9d-3ec7cfd607a8`
> 原升级分支：`feat/comprehensive-2.0-upgrade`
> 合并状态：2026-07-12 已快进合并到 `main`，正式候选版本调整为 `1.38.0`

## 结论

当前分支已经完成原执行文档中的 P0、安全关键项、主要首屏性能项、工程门禁，以及 P4 的前三项产品增强；但不能宣称“把 MD 全部落地”。剩余工作主要集中在：

1. P1 测试矩阵的少数缺口；
2. API 错误层全量迁移；
3. 硬编码 UI 文案及可访问性收尾；
4. 后端 JS 双轨向 TypeScript modules 的继续迁移；
5. 四个巨型前端 hook 的继续拆分；
6. 跨 Provider 会话审计产品页；
7. 真实签名私有 feed 下的 `1.37.0 -> 1.38.0` 更新链验证；
8. 需用户明确确认后才能执行的 `.claude/worktrees` 删除。

## Phase 0

| 项目 | 状态 | 当前证据 / 剩余工作 |
|---|---|---|
| P0-1 OpenCode 测试环境隔离 | 已完成 | 带外部 API Key 环境仍可通过 server tests。 |
| P0-2 Provider 模型发现凭据外泄 | 已完成 | 已保存密钥不能随请求体覆盖目标地址；非法协议与目标变更均有回归测试。 |
| P0-3 模型缓存 merge 写 | 已完成 | v2 cache、密钥指纹、串行 read-merge-write、磁盘条目保留测试已存在。 |
| P0-4 仓库卫生 | 部分完成 | `.review-*` 和 `.claude/worktrees/` 已 ignore，根级 review 文件已清理；`.claude/worktrees` 仍为约 6.3GB / 664 个 worktree，按原文要求未擅自删除。 |

## Phase 1

| 项目 | 状态 | 当前证据 / 剩余工作 |
|---|---|---|
| P1-1 autoDiscover 移出全局互斥 | 已完成 | 保存先响应 `discovery: pending`，后台发现，配置指纹一致时才写回。 |
| P1-2 缓存键加入密钥指纹 | 已完成 | SHA-256 截断指纹进入 cache key，磁盘版本为 v2。 |
| P1-3 CLI 并发与来源识别 | 已完成 | 同工具 mutation 互斥；Homebrew/npm/pnpm/Volta/standalone 严格识别；unknown 禁止自动更新。 |
| P1-4 Registry 类型与一致性 | 已完成 | Provider 模板已迁 TypeScript；Runtime/Manifest 双向检查；返回防御性副本。 |
| P1-5 核心测试矩阵 | 已完成 | 攻击路径、非法 URL、上游 401、异步发现、失败写回、缓存 merge/TTL 过期/pending 去重、CLI 并发/来源、Registry 错误码均已覆盖；Provider 模板断言已改为结构校验。 |
| P1-6 token 移出普通 HTTP URL | 已完成 | 会话 SSE 搜索改 Authorization header；query token 仅保留 WebSocket/shell 握手。 |
| P1-7 TaskMaster 移除 shell | 已完成 | 当前 server 源码未发现 `shell: true`。 |
| P1-8 Provider UI 小修 | 已完成 | 模板覆盖确认、stored key 安全发现、统一 cache/status label、autoDiscover 开关均已落地。 |

## Phase 2

| 项目 | 状态 | 当前证据 / 剩余工作 |
|---|---|---|
| P2-1 首屏 syntax chunk | 已完成 | `dist/index.html` 无 syntax preload。 |
| P2-2 面板级 lazy | 已完成 | Chat、Files、Shell、Git、Plugin、Browser、Editor、TaskMaster、Settings 均按需加载。 |
| P2-3 i18n 动态加载 | 已完成 | `import.meta.glob` 按语言和 namespace 加载。 |
| P2-4 热路径 memo | 已完成 | 指定组件与 Plugins/Theme context value 已 memo。 |
| P2-5 API 统一错误处理 | 部分完成 | 已有 `apiRequest` / `ApiError`，Git API 已统一；但 `authenticatedFetch` 仍有约 143 个调用，Projects、Settings、TaskMaster、Provider、Files 尚未完成统一迁移。 |
| P2-6 硬编码文案 | 部分完成 | CLI 状态已覆盖 10 种语言，但 renderer 仍有约 30 个包含硬编码中文的源文件；英文硬编码也未完全清零。 |
| P2-7 可访问性 | 部分完成 | 原文指定的 SidebarProjectItem、复制按钮、emoji 已修；语义色与全仓图标按钮/可点击容器仍需系统扫描。 |

当前生产构建只 preload：入口、React vendor、CSS；入口 JS 约 586KB，达到原文 `<600KB` 目标。

## Phase 3

| 项目 | 状态 | 当前证据 / 剩余工作 |
|---|---|---|
| P3-1 后端双轨合流 | 部分完成 | Files、Leoapi、Git、TaskMaster、Agent、四个 Runtime adapter 已迁入 `server/modules/`；但 `server/index.js` 仍 754 行，Leoapi 仍 2225 行，Git 1649 行、TaskMaster 1469 行、Agent 1286 行，且这些 routes 多数仍是 JS。根级 `server/routes/` 仍保留约 8 个业务路由。 |
| P3-2 shared 归一 | 部分完成 | 根级 `shared/` 已删除，Provider templates 已 TS 化；`server/shared/network-hosts.js` 仍为 JS，未达到 server/shared JS 清零。 |
| P3-3 巨型 hook 分解 | 部分完成 | Composer 1222→1032、Projects 1104→798、Sidebar 998→852、Git 820→712；已抽附件、发送选项、项目状态转换、会话搜索、Git API 等职责，但尚未达到每个 hook 3–5 个组合 hook 的目标，也未解决全部 prop drilling。 |
| P3-4 工程化补强 | 已完成 | 客户端测试递归发现、全域 ESLint 零 warning、Husky/Commitlint、release 元数据单一真相源、公证 cleanup、签名设计文档均已落地。 |
| P3-5 测试补强 | 持续进行 | 当前共 51 个测试文件，其中 client 11、server 35；总测试 212 项。迁移模块已有新增测试，但 API、巨型 hooks、归档/Star、Git 状态组合逻辑仍需覆盖。 |

## Phase 4

| 项目 | 状态 | 当前证据 / 剩余工作 |
|---|---|---|
| Provider 健康面板 | 已完成 | 健康/降级/失败/未验证，延迟、模型数、成功/失败时间已显示。 |
| 用户确认式故障切换 | 已完成 | 只提供建议与确认式切换，不静默自动改配置。 |
| CLI 版本漂移告警 | 已完成 | 24 小时缓存、手动强刷、安装/更新后强刷、stale cache 降级。 |
| 跨 Provider 会话审计 | 部分完成 | 已有跨 Provider 会话内容搜索和 Sidebar 搜索 UI；尚无独立审计/回放页，也缺项目、Provider、日期、工具调用、错误、权限请求、Token 用量筛选。 |

## 发布与交付验证

已完成：

- typecheck、lint、212 项测试、build；
- 当前 HEAD 的 `desktop:pack`；
- 隔离 profile 启动、健康接口、Provider capability、SQLite 原生模块、退出后端口释放；
- 未签名 DMG 构建、挂载、版本字段、ad-hoc 结构签名与 `hdiutil verify`；
- 分支已推送到 `origin/feat/comprehensive-2.0-upgrade`。

仍未完成：

- 使用 Developer ID 签名的 1.38.0 测试资产；
- Apple 公证、App/DMG staple、Gatekeeper 下载后复验；
- 私有测试 feed 下从真实 1.37.0 更新到 1.38.0，并验证下载、安装与重启完整链路；
- 后续版本继续按正常递增 semver 发布，不再使用合成版本。

因此当前分支可作为已验证的开发交付分支，但不能仅凭本地未签名验证宣称正式更新链已经完成。

## 下一批执行顺序

1. 继续 Leoapi 拆分：Feedback/Update 子路由，再拆 Provider Switch 的 store、discovery、transaction service；
2. Sidebar archive/Star 与 Chat Composer queue/command 继续拆分并补测试；
3. API 错误层优先迁 Projects 和 Settings；
4. 分批清理 Workspace shell、Appearance、Browser settings 等硬编码文案；
5. 增强跨 Provider 搜索筛选，逐步形成审计页；
6. 有签名凭据和测试 feed 后执行真实更新桥 E2E；
7. `.claude/worktrees` 仅在用户明确确认删除后处理。

## 接续执行检查点（第二轮拆分后）

> 此节记录 `019f5191-cd40-71c3-aeb6-1eda68fd6f04` 中断后接续执行的当前工作树状态。改动尚未统一提交或推送。

### 已完成的新进展

1. **统一 API 错误层完成 renderer 全量迁移**
   - 业务组件、Hook、Context 和 Store 不再直接调用 `authenticatedFetch` 或旧 `api` endpoint wrapper。
   - JSON、PATCH/DELETE、带 query 的 DELETE、FormData、二进制响应和 SSE 均通过 `apiClient`、`apiRequest`、`ApiError`。
   - 旧 `src/utils/api.js` 从 326 行缩减为 58 行，仅保留认证 fetch 与统一错误原语。
   - 新增二进制错误、DELETE query 语义和 SSE 事件解析测试。

2. **四个巨型 Hook 第二轮拆分完成**
   - `useChatComposerState.ts`：667 行；队列、命令、附件和发送选项均已独立。
   - `useProjectsState.ts`：582 行；实时事件、Session Attention、分页和状态转换均已独立。
   - `useSidebarController.ts`：602 行；归档、Star、搜索和项目/会话操作已拆分。
   - `useGitPanelController.ts`：606 行；API Client 与 Remote Operations 已拆分。

3. **新增独立会话审计/回放页**
   - 新增 `audit` 工作区 Tab，按项目、Provider、日期和查询词筛选。
   - 支持完整会话消息回放、工具调用/错误/权限事件筛选、Token 用量显示和 JSON 导出。
   - 审计页独立懒加载，生产 chunk 约 8.45KB。

4. **i18n 与可访问性继续收尾**
   - Browser Settings、Workspace Shell、Appearance、Auth、本地错误页、Command Palette、应用更新、Provider 登录终端和 Sidebar 本机入口已迁入 locale。
   - 所有 10 个 locale 均有结构完整性测试；非中文语言当前可使用英文翻译作为阶段性占位。
   - renderer 源码中的硬编码中文已清理，仅保留语言选择器中的语言原生名称。
   - 模态遮罩改为语义按钮；Task Detail 图标按钮补充类型、aria-label 和 aria-expanded。

### 当前验证证据

```text
Typecheck：通过
ESLint：0 errors / 0 warnings
Desktop tests：16/16
Client tests：38/38
Server tests：168/168
总测试：222
Production build：通过
入口 JS：580.58KB（仍低于 600KB 目标）
git diff --check：通过
```

### 仍需继续，不能据此宣称全部升级完成

- 后端模块仍有 43 个 JavaScript 文件；Agent、Git、TaskMaster、Files 和 Provider Switch 的主要 route/service 需要继续 TypeScript 化及进一步分层。
- 部分英文 UI 文案仍需继续提取到 i18n；当前已完成原文点名的中文硬编码主线和最显著工作区入口。
- 会话审计页已具备筛选、回放、事件分类、Token 与导出，但仍应补充组件级交互测试和大数据量分页/取消行为验证。
- 真实签名、公证和私有更新 Feed E2E 按用户要求不在本机执行。
- `.claude/worktrees` 删除仍需用户单独明确确认。

## 接续执行检查点（2026-07-12）

### 后端 TypeScript 化进展

- Files 原 762 行 JavaScript 巨型路由已完全移除，替换为严格 TypeScript 子路由：
  - `workspace-filesystem.routes.ts`
  - `file-content.routes.ts`
  - `file-mutation.routes.ts`
  - `file-upload.routes.ts`
  - `files.routes.ts` 纯装配入口（15 行）
- 文件上传迁移时修复了旧实现使用 `os.tmpdir()` 却未导入 `node:os` 的运行时缺陷。
- 文件上传恢复并测试了 Multer 文件大小/数量错误的 JSON 响应语义。
- 新增 Files 路由集成测试：工作区越界拒绝、无文件上传校验。
- 以下模块也已迁入严格 TypeScript：
  - CORS policy
  - WebSocket runtime 装配
  - Server lifecycle
  - Provider Switch config/storage/version network utilities
  - Leoapi/Agent/Git/TaskMaster/Files index 装配
  - TaskMaster installation service、PRD parse routes、template routes
- TypeScript 迁移发现并修复了 TaskMaster parse 后 WebSocket 广播缺少第三个 `tasksData` 参数的问题。

### 会话审计稳定性

- 项目会话加载增加并发上限（4），避免项目较多时同时发起无界请求。
- 刷新、组件卸载和会话切换均通过 AbortController 取消旧请求。
- 新增并发限制单元测试。

### 当前验证

```text
Typecheck：通过
ESLint：0 errors / 0 warnings
Desktop tests：16/16
Client tests：39/39
Server tests：170/170
总测试：225/225
Production build：通过
入口 JS：581.19KB（低于 600KB）
git diff --check：通过
```

### 当前迁移数量

```text
server 全部 JavaScript 文件：74 → 58
server/modules + runtime + middleware JavaScript：43 → 27
```

下一步继续处理 TaskMaster 主路由/模板服务、Git、Agent 与 Provider Switch 的剩余 JavaScript 服务和路由。

## 接续执行检查点（2026-07-12，第三轮）

### 后端 TypeScript 化继续推进

- Git 主路由、远程操作路由、工作区操作路由及服务层已全部迁入严格 TypeScript。
- Token Usage 路由、认证中间件、通知编排服务已迁入严格 TypeScript。
- Leoapi 的 CLI Tools、Feedback/Update、Provider Store、Backup、Apply 服务已迁入严格 TypeScript。
- 为无内置类型声明的 `jsonwebtoken` 与 `web-push` 增加了最小本地声明，不新增运行时依赖。
- TypeScript 迁移额外发现并修复了三处会在运行时触发的问题：
  - Git status 路由漏导入 `parseGitStatusOutput`；
  - Git remote 路由漏导入 `validateBranchName`；
  - CLI status 路由调用了未定义的 `nowIso`。

### 当前验证

```text
Typecheck：通过
ESLint：0 errors / 0 warnings
Desktop tests：16/16
Client tests：39/39
Server tests：172/172
总测试：227/227
Production build：通过
入口 JS：581.19KB（低于 600KB）
git diff --check：通过
```

### 当前迁移数量

```text
server 全部 JavaScript 文件：74 → 42
server/modules + runtime + middleware JavaScript：43 → 11
其中生产 JavaScript：9（另有 2 个 JavaScript 测试文件）
```

剩余生产 JavaScript 已收敛为：Agent routes/service、Provider Switch routes/discovery/import，以及 Claude/Codex/Cursor/OpenCode 四个 runtime adapter。真实签名、公证、私有更新 Feed E2E 与 `.claude/worktrees` 删除仍不在本机自动执行。

## 合并收口（2026-07-12）

- `feat/comprehensive-2.0-upgrade` 的 20 个提交已快进合并到本地 `main`。
- 放弃 `1.37.0 -> 1.1.5` 的版本回退方案，候选版本改为单调递增的 `1.38.0`，更新元数据使用正常 semver。
- 修正 TypeScript 开发入口、迁移文件行尾空格和 Electron 本地服务格式遗留。
- Typecheck、全域 ESLint 零警告、228/228 项测试、生产构建、净设备测试、生产依赖审计和 `desktop:pack` 均通过。
- 打包 App 已在独立端口实机启动，健康接口返回 `1.38.0`，识别 6 类 CLI，退出后端口正常释放。
- README 下载入口继续指向已签名公证的 `1.37.0`；DMG、Developer ID 签名、公证和部署待候选版确认后单独执行。
