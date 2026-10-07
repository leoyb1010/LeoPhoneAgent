# LeoPhoneAgent · Paperclip 中文服务器发行层

这里交付的是**可审查、固定源码版本、构建前完成的简体中文发行层**。Web 管理后台由 Paperclip 服务器提供，Mac 客户端连接这个服务；智能体 CLI 在服务器或管理员配置的运行环境执行，不会因此获得用户 Mac 的终端能力。

- 上游：`paperclipai/paperclip`
- 固定提交：`994d6edcdd4e15d5f9cc5cf8c135ac599104b86a`
- 授权：MIT，完整保留于 `LICENSE.paperclip`；编辑器翻译 hook 的依赖归属于 `LICENSE.mdxeditor`
- 源码工具本身不自动部署、建立账号或登录模型；生产实例的部署与真实运行验证另见项目 `docs/paperclip/` 交付记录

## 部署路线

**当前主线：macOS launchd 原生部署**（外接盘部署根、`scripts/start-native-server.sh` 启动模板、原生 CLI 叠层与头像运行时叠层）。完整步骤见 [中文部署手册](docs/DEPLOYMENT.zh-CN.md)。

Docker 镜像（`build-image.sh`、`compose.example.yaml`）是**未验收的可选路线**：脚本会核对三层源码叠加后再构建，但镜像运行、原生 CLI 授权与头像 worker 均未在 Docker 中验收。

## 使用

```sh
cd src/server/paperclip
npm ci --ignore-scripts
./scripts/prepare.sh /你的独立工作目录/paperclip-zh        # 从固定提交生成中文源码（三层叠加并核对）
npm run test:full                                         # 或下方完整命令，见“测试”
./scripts/check-upstream.sh /你的独立工作目录/paperclip-zh # 安装上游依赖后运行回归、类型检查、UI 构建与冒烟
```

`prepare.sh` 只准备源码，不启动服务。已有目标目录必须处于锁定提交；工具拒绝覆盖无关本地改动，不执行 `git reset`。各叠层可以重复应用，也可以离线对已经检出的上游运行：

```sh
node scripts/localize.mjs apply /path/to/paperclip            # 汉化（catalogs/，按 catalogs/order.json 顺序应用结构补丁）
node scripts/apply-test-storage.mjs apply /path/to/paperclip  # 测试临时目录叠层
node scripts/apply-native-cli-auth.mjs apply /path/to/paperclip  # 原生后端/CLI/安全叠层（native/）
# 对应 verify 子命令只核对，不写入
```

## 测试

`npm test` 只运行不依赖上游源码的部分；**多数回归需要固定上游源码目录**，未设置时会被跳过，并在结尾打印“N 项因缺少 PAPERCLIP_SOURCE 被跳过”。两个环境变量：

- `PAPERCLIP_SOURCE`：固定提交的上游 Git 工作区（只读取 `git show HEAD:<文件>` 的原始内容，在内存中重放补丁做断言；工作区是否已打补丁不影响）。
- `PAPERCLIP_CANDIDATE`：已经由 `prepare.sh` 生成的候选树，用于核对实际写出的产物（可与 SOURCE 是同一目录）。

完整命令（默认指向本目录下被 git 忽略的 `.upstream`）：

```sh
npm run test:full
# 等价于
PAPERCLIP_SOURCE=.upstream PAPERCLIP_CANDIDATE=.upstream npm test
python3 tests/native-launcher.test.py
```

部分发行层回归（如 `costs-realtime`、`round1-data`）还会加载上游 `ui/node_modules`，因此需先在上游树执行 `npx -y pnpm@9.15.4 install --frozen-lockfile`；`check-upstream.sh` 已按此顺序执行。

## 版本记录

- 1.1.0：独立、默认关闭的 Mac 原生 CLI 状态与网页授权叠层，受实例管理员和公司权限限制，复用原有会话、AI 连接存储及清理机制，不开启公网 MCP 信任。
- 1.1.1：取消 OpenCode 新建配置的隐式 OpenRouter 账号绑定，见 [交付记录](../../../docs/paperclip/CLI_PROVIDER_FIX_20261004.md)。
- 1.1.3：Cursor/Hermes/OpenCode 配置、费用实时刷新与 macOS 数据库启动修复，见 [服务器审计记录](../../../docs/paperclip/SERVER_AUDIT_20261004.md)。
- 1.1.5：跨标签页账号隔离、CLI 自检、模型选择、分页、文件及备份恢复的两轮审计，见 [记录](../../../docs/paperclip/TWO_ROUND_AUDIT_20261005.md)。
- 1.1.8：全站页面可用性审计（本地 local_trusted 与 authenticated 两种模式、管理员/普通成员/未登录）：未登录与 401/403/404 不再指数重试（登录跳转与“未找到”从约 7 秒降到 0.5 秒内，服务端 4xx 日志减少）；没有组织访问权限的账号可退出登录；删除组织不再因 projects.goal_id / budget_policies 等外键返回 500；已取消任务在取消时收尾等待恢复的已保存消息，且已完成/已取消任务不再显示恢复横幅；空闲任务页轮询由每秒 3 次降到 5 秒一次；审计时间线对已终止/已删除智能体标记“已归档”并不计入数量。见 [审计记录](../../../docs/paperclip/UI_USABILITY_AUDIT_20261007.md) 与 [线上数据清理程序](../../../docs/paperclip/LIVE_DATA_CLEANUP_20261007.md)。
- 1.1.6：覆盖门禁恢复为绿；原生 CLI、授权 PTY 与智能体执行子进程剔除服务器私密变量；安全响应头与请求日志降噪；跨标签会话标记冷加载不再重挂载；恢复解压设上限并在备份同目录私有解压；结构补丁显式排序；既有 40 条 UI 测试断言按中文/新契约更新。

macOS 原生服务的 CLI 路径、已有登录和代理继承说明见部署手册；维护方法和验证范围见 [中文化维护说明](docs/LOCALIZATION.zh-CN.md)、[覆盖矩阵](docs/COVERAGE.zh-CN.md)。

## 实现边界

这不是浏览器自动翻译，也不是 DOM 文本替换。TypeScript AST 只识别显示文案位置，使用可审阅词库在构建前改写源码；复杂模板和帮助函数使用固定上下文补丁。生产版及普通版页面均纳入处理。

用户填写的任务标题/正文、评论、智能体输出、文件内容、公司名称不会被自动翻译；API 字段、路由、缓存键、协议枚举、权限判断、金额数值及币种也不会改变。CLI 输出、原始诊断、品牌、模型名、命令和路径保留原文。默认界面语言为 `zh-CN`，金额仍为美元，并不执行汇率换算。

代码里存在的候选文案数量不等于实际翻译数量，也不能证明所有运行态页面都已验收。`reports/coverage.json` 提供逐文件的实译/剩余清单，覆盖矩阵会明确未覆盖的功能与未完成的验证。
