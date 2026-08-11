# leocodebox 1.38.0

发布日期：2026-07-12

## 重点修复

- 封堵已保存 Provider API Key 可被模型发现接口发送到任意 Base URL 的高危漏洞。
- 模型发现缓存升级为带密钥指纹的 v2 格式，并使用并发安全的 read-merge-write，避免重启后静默丢项。
- Provider 保存后的模型发现移到后台执行，不再阻塞 apply、rollback、delete 等配置事务。
- CLI 安装和更新增加同工具并发互斥，未知安装来源拒绝自动更新，避免 shadow 全局安装。
- 普通 HTTP/SSE 搜索认证改用 Authorization header，不再把 token 写入 URL。
- Provider 模板迁移为类型安全的 TypeScript 单一事实源，并强化 Registry 双向一致性校验。

## 性能与工程

- Markdown 语法高亮、工作区面板、设置、登录终端按需加载。
- 翻译资源按语言和 namespace 动态加载。
- 首屏入口 JS 从约 1.56 MB 降至约 585 KB，首屏不再 preload syntax、CodeMirror、xterm、KaTeX 等重型模块。
- 客户端测试改为递归发现；ESLint 覆盖 renderer、server、Electron 和 release scripts，门禁为零 warning。
- Husky pre-commit 与 commit-msg hooks 正式落地。

## 从旧版本升级

产品版本从 `1.37.0` 单调递增到 `1.38.0`，不再采用版本号回退或合成 feed 版本。已安装 `1.36.x`、`1.1.3` 或 `1.37.0` 的客户端均按正常 semver 识别本次升级。

正式发布仍必须经过 Developer ID 签名、公证、staple、重新下载验证后才能更新正式 feed。

## Workspace 2.0 架构升级

- 原服务入口中的文件系统 API 已迁移到 `server/modules/files/`，并增加路径穿越及符号链接逃逸测试。
- Claude、Codex、Cursor、OpenCode Runtime 已归入各自 Provider 模块；Agent、Git、TaskMaster、Leoapi 路由统一归入 `server/modules/`。
- Leoapi CLI 管理已拆为独立子路由，Git 前端请求统一经过 `apiRequest` / `ApiError`。
- Chat Composer、Projects、Sidebar Conversation Search、Git Panel 已开始按职责拆分，并补充状态转换、SSE、附件及 API 错误测试。
- Provider 卡片增加健康、降级、失败、未验证状态，以及经过用户确认并自动备份的备用 Provider 切换。
- CLI 版本漂移检查使用 24 小时 Registry 缓存，手动刷新和安装/更新后可强制重新检查。
- CLI 状态界面已覆盖全部 10 种支持语言。

## 已完成的发布候选验证

2026-07-12 已完成以下发布前验证：

- TypeScript 检查、全域 ESLint 零警告、228 项自动化测试和生产构建通过。
- 净设备测试通过：免登录、6 类 CLI 发现、空本地状态均可正常处理。
- `npm run desktop:pack` 成功，打包应用可使用隔离 profile 启动。
- 打包应用健康接口返回产品版本 `1.38.0`，Provider 控制面返回 4 个 Runtime、8 个 Manifest 和 16 个模板。
- `better-sqlite3` 原生模块可在 Electron 运行时加载，应用退出后后端端口正常释放。
- 生产依赖安全审计为 0 个漏洞。

正式发布必须完成 DMG 生成、Developer ID 签名、Apple 公证、staple、Gatekeeper、隔离属性启动和真实下载资产校验；未通过其中任一步骤不得更新正式 Release。
