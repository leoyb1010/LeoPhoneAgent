# v1.39 审查报告落地记录

依据 `docs/review-cli-agent-update.md` 执行。

| 条目 | 状态 | 1.39 落地 |
|---|---|---|
| A1 | 完成 | npm-global 优先于 Homebrew；补齐 Claude/Codex/Gemini brew 映射。 |
| A2 | 完成 | 不支持/不可用/跳过检查改为中性状态；独立安装器可检查并更新。 |
| A3 | 完成 | 增加 Cursor、OpenCode、Grok、Bun、asdf、mise 等来源识别及手动命令。 |
| A4 | 完成 | OpenCode、Hermes、Grok 配置官方自更新参数。 |
| A5 | 完成 | 状态返回 `mutationsAllowed`，非桌面模式禁用并解释。 |
| A6 | 完成 | Windows 使用 `where`，`.cmd/.bat` 使用 shell 执行。 |
| A7 | 完成 | 不可自动更新时显示可复制手动命令。 |
| A8 | 完成 | 统一 300 秒超时、显示原始输出、批量更新、局部缓存刷新和骨架屏。 |
| A9 | 完成 | 正确比较 prerelease；网络错误透传。代理沿用 Electron 注入的标准代理环境。 |
| B1 | 条件完成 | generic feed 已支持；私有 GitHub 匿名访问实测 404，不能在客户端绕过仓库权限。 |
| B2 | 完成 | README 和 API 文档按真实更新行为修订；服务端检查接口保留为 Web 状态能力。 |
| B3 | 完成 | 插件修改统一套用本机门禁。浏览器运行时升级继续由插件版本管理。 |
| B4 | 按报告拆分 | Express 4 类型将在依赖审计中对齐；React 19、Router 7、Tailwind 4 按原报告要求分开升级，不混入 1.39 功能版本。 |
| B5 | 完成 | 增加来源、命令、semver 和 HTTP 门禁测试；限制测试后门；修复原型链查表；补 CLI API 文档；删除未引用组件并移除 OpenCode 空权限页。 |

## 验收要求

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:clean-device`
- 签名应用在隔离用户环境中发现七类 CLI（包括 Grok Build），退出后释放 38473。
