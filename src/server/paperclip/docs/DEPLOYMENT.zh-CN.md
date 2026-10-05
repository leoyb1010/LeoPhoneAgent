# 中文服务器部署手册

## 1. 架构与执行位置

Mac 应用是连接和操作 Paperclip 的入口，服务器提供中文管理界面、认证、组织、任务、智能体、审批、预算和审计。选择 `codex_local`、`claude_local` 等本地适配器时，“本地”指 **Paperclip 服务进程所在的主机/容器**，并不指用户的 Mac。工作目录也必须是服务器可见路径。远程操控用户 Mac 不在此实现范围内。

中文化不绕开审批、预算强制停止、组织访问边界、任务单负责人或原子领取机制，也不修改服务器认证 API。

## 0. 路线说明

**当前主线是 macOS launchd 原生部署**：固定提交生成中文源码 → 安装上游依赖并验证 → 上游 UI/服务端构建 → 原生头像运行时叠层 → 以 `scripts/start-native-server.sh` 由 launchd 启动（见第 4 节各 macOS 小节）。第 2–3 节的 Docker 镜像与 compose 模板是**未验收的可选路线**，仅保留供参考。

文中 `<部署根>` 指服务用户的 Paperclip 部署根目录（启动模板默认 `~/.leophoneagent/paperclip`，可由 `PAPERCLIP_DEPLOY_ROOT` 指定），`<外接卷>` 指承载部署根的外接卷挂载点（`/Volumes/<卷名>`），`<短测试临时目录>` 指该卷上的短路径临时目录。请按实际环境替换，不要把真实路径、主机名或账号写进公开仓库。

### 原生部署从固定提交生成候选（每次发布）

```sh
cd src/server/paperclip
npm ci --ignore-scripts
./scripts/prepare.sh <部署根>/candidates/<候选名>          # 新目录：克隆固定提交并应用、核对三层叠加
./scripts/check-upstream.sh <部署根>/candidates/<候选名>   # 先装上游依赖，再跑回归/类型检查/UI 构建/冒烟
cd <部署根>/candidates/<候选名>
npx -y pnpm@9.15.4 --filter @paperclipai/plugin-sdk ensure-build-deps
npx -y pnpm@9.15.4 --filter @paperclipai/plugin-sdk build
npx -y pnpm@9.15.4 --filter @paperclipai/shared build
npx -y pnpm@9.15.4 --filter @paperclipai/ui build
npx -y pnpm@9.15.4 --filter @paperclipai/server build
cd -
node scripts/apply-native-avatar-runtime.mjs apply <部署根>/candidates/<候选名>
node scripts/apply-native-avatar-runtime.mjs verify <部署根>/candidates/<候选名>
```

候选验证通过后，先把生成结果固化到候选的本地 Git 分支并打标签（`git -C <候选> checkout -b leophone/<版本> && git add -A && git commit`），保证线上代码可复现，再切换。不要在线上目录直接修改源码。

切换使用 `scripts/deploy-native-release.py`（在服务器上以服务用户运行）：

```sh
python3 scripts/deploy-native-release.py --root <部署根> --candidate <部署根>/candidates/<候选名> --dry-run
python3 scripts/deploy-native-release.py --root <部署根> --candidate <部署根>/candidates/<候选名> --public-url https://<公网域名>
```

脚本依次：拒绝未提交的候选与有 running/queued 任务的实例 → 私有 `pg_dump -Fc` 并 `pg_restore --list` 校验 → 建立 `release/previous` → 保留旧散列静态资源 → 原子切换 `release/current` → 只发送 SIGTERM，等待上游优雅排空后由 launchd KeepAlive 拉起新版本（不用 `bootout`/`kickstart -k`，它们约 20 秒后强杀）→ 核对健康状态与回环/公网 index 哈希；任一步失败自动切回旧版本。切换（及回滚）时还会把 `~/.hermes/skills`、`~/.claude/skills`、`~/.cursor/skills`、`~/.pi/agent/skills` 等 CLI 技能目录中指向本部署根旧版本 `skills/<名称>` 的 Paperclip 技能链接改指到当前版本：否则旧目录仍在时 Hermes 会以 "occupied by another installation" 拒绝启动，其他 CLI 静默读取旧技能；用户自己安装的技能不受影响。也可单独运行 `--repoint-skills-only`。证据写入 `<部署根>/backups/deploy/<时间>-<候选名>/`（0600）。

### 数据库口令与库级认证

共享 Homebrew PostgreSQL 集群默认对本机 trust。`scripts/harden-db-auth.py` 只针对本项目库：`rotate` 轮换口令（只向数据库发送 SCRAM-SHA-256 校验值，明文不进 SQL 或输出）并更新 `env/server.env` 与实例 `config.json`；随后重启服务使用新口令；`enforce` 在 `pg_hba.conf` 首条规则前为本项目库加 `scram-sha-256` 规则并 reload；`verify` 确认新口令可连、无口令（包括超级用户）被拒、其他库不受影响。三步的修改前副本保存在 `<部署根>/backups/db-auth/`。其他服务的数据库认证规则不变。

### 日志轮转

启动模板在每次启动时检查 `log/server.stdout.log` 与 `server.stderr.log`，超过 32 MiB 即压缩为 `.1.gz` 并顺延，保留 3 份；无需系统级 newsyslog。

## 2. 构建前准备（Docker 可选路线，未验收）

需要 Git、Node.js 24.11+、上游固定的 pnpm 9.15.4；镜像构建还需要支持当前 Dockerfile 语法的 Docker/BuildKit 和足够磁盘空间。上游包含 Rust Runner 编译，依其 `rust-toolchain.toml` 安装锁定工具链。首次依赖下载和镜像构建较大，请预留时间。

```sh
cd src/server/paperclip
npm ci --ignore-scripts
./scripts/prepare.sh /srv/build/paperclip-zh
./scripts/check-upstream.sh /srv/build/paperclip-zh
./scripts/build-image.sh /srv/build/paperclip-zh leophone-paperclip-zh:994d6ed   # 构建前核对汉化、测试存储、原生三层叠加
```

`prepare.sh` 从 MIT 上游的固定 Git 提交生成中文源码。源码依赖使用上游锁文件，中文化工具使用自己的 `package-lock.json`。**这保证源码转换可复现，不保证镜像字节完全相同**：上游 Dockerfile 仍包含系统软件包和部分 `@latest` CLI 安装。正式生产应记录构建产物镜像 digest，并对计划使用的 CLI 独立冻结版本与执行验收；不要直接滚动部署一个可变 tag。

构建明确选择上游 `production` target，不会误用云托管专用 `cloud` target。

## 3. 启动与网络（Docker 可选路线，未验收）

`compose.example.yaml` 是需管理员审阅的模板，不会由构建脚本执行。它默认把端口只映射到宿主机 `127.0.0.1`，并启用认证模式。管理员应通过安全凭据入口设置两个互相独立的高熵签名密钥：`BETTER_AUTH_SECRET`、`PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`。不要将密钥写入 Git、聊天记录、公开日志或客户端构建。

必须设置 `PAPERCLIP_PUBLIC_URL` 为浏览器实际访问的完整地址。自托管浏览器会话依赖同源 Cookie，请在同一 HTTPS 域名代理 UI、`/api` 和 WebSocket；不要只代理首页。跨设备访问由管理员配置 TLS 反向代理或受信私有网络，本模板不会自动配置防火墙、DNS、证书或公网监听。

- `authenticated/private`：用于局域网、VPN 等私网，要求登录
- `authenticated/public`：用于已加固的公网 HTTPS 部署，要求登录，首次管理员需主机生成一次性邀请
- `local_trusted`：无需登录，只适合受信单人本机；不要暴露到网络，也不建议作为 Mac 客户端远程连接模式

审核模板和权限后，管理员可自行启动：

```sh
docker compose -f compose.example.yaml up -d
```

随后检查日志和健康接口：

```sh
docker compose -f compose.example.yaml logs --tail=100 paperclip
curl --fail http://127.0.0.1:3100/api/health
```

健康接口成功不等于智能体能够执行。还需要完成下面的认证和真实执行验收。

## 4. 首次管理员与模型连接

1. 打开实例地址，使用中文“登录 / 创建账号”页面
2. 私有认证模式下，按页面引导认领首次管理员；若实例已被认领，应联系管理员邀请，不要绕过权限
3. 公开认证模式下，在服务器运行上游命令生成一次性的管理员邀请，然后在浏览器打开邀请链接：

   ```sh
   cd /srv/build/paperclip-zh
   pnpm paperclipai auth bootstrap-ceo
   ```

   容器部署可在对应容器 `/app` 工作目录运行同一命令。邀请链接属于认证凭据，不要转发给其他人或写入公开工单
4. 创建组织，创建智能体，连接受支持的模型订阅或 API 服务。凭据由用户/管理员在安全认证流程中输入
5. 智能体“运行环境”和“工作目录”指向服务器实际可访问的环境。先测试连接，再创建一个无敏感数据的最小任务
6. 检查任务状态、日志、审批通知、预算计费是否一致，再逐步引入真实工作

上游提供的“简化技术英语交互”实验开关会影响模型输出语言，中文场景请保持关闭。界面汉化并不保证第三方模型或用户提供的内容必然输出中文。若要模型用中文，请在组织/智能体指令中明确要求，同时保留命令、标识和错误日志原文。

### macOS 原生服务的 CLI 与已有登录

`codex_local` 的 CLI 和登录状态归属运行服务的系统用户。浏览器“执行框架 / 运行环境 → 运行测试”会验证实际命令、认证以及最小模型响应；登录状态存在不代表网络或执行已经正常。配置页可以选择现有认证或托管连接，查看测试详情，不需要把 auth.json、密码或令牌复制到浏览器。

原生 launchd 服务可使用 `scripts/start-native-server.sh` 模板。默认部署根为该服务用户的 `~/.leophoneagent/paperclip`，可用 `PAPERCLIP_DEPLOY_ROOT` 显式指定。发行层 1.1.6 起，模板在加载 `<部署根>/env/server.env` 之前确认它是服务用户拥有、权限不宽于 0600 的普通文件（非符号链接），否则以退出码 78 拒绝启动，不会自动修改权限；模板保留项目锁定 Node 在 PATH 首位，同时包含该用户的 npm 全局 CLI 和 `~/.local/bin`。自定义 npm 前缀使用 `PAPERCLIP_CLI_BIN_DIR`。不要仅以 SSH 终端的 `command -v codex` 作为服务进程可用的证据。

如果管理员的本机 CLI 已依赖本机代理，launchd 不会自动继承交互 shell 的代理变量。在私有 `env/server.env` 中显式配置同一个已验证代理，并排除本机 API/数据库地址，例如：

```sh
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy=localhost,127.0.0.1,::1
```

示例端口必须按实际代理配置调整。启动模板不会擅自登录、改账号或设置代理；它只加载管理员已经保存的服务环境。先确认没有运行中/排队任务并保留旧配置，再重启服务；随后从远端浏览器执行连接测试及最小任务验收。执行引擎、模型和权限以管理员的智能体配置为准，不能为通过测试偷偷改成另一种引擎或降低权限要求。

### 原生 CLI 状态与网页授权

网页入口仍使用现有公网 HTTPS 地址；能力取决于部署配置和执行环境，不取决于请求来自域名还是 IP 加端口。发行层 1.1.0 将原生主机授权与 sandbox 授权分别路由，不设置 `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST`，不伪装 sandbox，也不改变全局 CLI 账号。

原生能力默认关闭。Mac 管理员在私有服务环境明确设置 `PAPERCLIP_NATIVE_CLI_LOGIN_ENABLED=true` 后，健康响应的 `nativeAdapterLoginSupported` 才启用本地环境网页授权。原有 `localAiLoginSupported` 仍代表上游终端隔离登录能力，两者不可混用。原生授权仅接受实例管理员、公司访问及智能体创建权限；会话启动和打开 PTY 时再次检查当前环境及权限。

Codex、Claude、Grok 使用原有设备码／授权码面板和会话生命周期，服务端只运行固定 CLI 参数；每个会话在外接盘创建独立私有认证目录。新授权通过原有 AI 连接存储及权限逻辑提升，不回写服务器用户的默认 `.codex` 或 Claude 认证。用户完成授权后还须明确采用；取消、超时或失败保留原连接。重新授权提供相同隔离流程，采用个人默认账号的影响在界面说明。

CLI 状态接口分别报告安装状态与认证状态：Codex/Claude 使用自身的只读状态命令，其他没有可靠状态命令的 CLI 报告未知，文件或 API 密钥存在不等于认证成功。不把未安装、未授权或未知状态统一误报成“不支持浏览器登录”。只有原生支持的设备码／授权码适配器提供该授权流程，其他类型沿其本身的 API 或 CLI 方式配置。

Cloudflare 代理仍仅转发回环服务。Claude 授权的私有传输检查应配置 `CLAUDE_LOGIN_TRUSTED_PROXIES=127.0.0.1,::1`，只信任实际本机隧道；不关闭认证或使用宽泛代理信任。TLS 仍由现有外网入口提供。

`prepare.sh` 应用原生后端叠层并验证固定上游版本及精确上下文；未知已有源码修改会被拒绝。重新构建后按本节进行权限、状态读取、授权开始／取消、旧登录保持及真实执行验收。提供商最终登录或账号同意步骤需要账号持有人亲自完成，不在日志或交付文档中保存授权码、令牌或原始终端输出。

### 原生编译版头像 worker

本次固定上游的 shared 包子路径导出指向 TypeScript 源码，但编译后的头像 worker 没有源码分支的 TSX 启动包装，导致 `definition.js` 模块解析失败及头像 HTTP 503。原生构建须先完成 shared/server 的上游构建，再在物理源码目录应用、验证独立运行时叠层：

```sh
node scripts/apply-native-avatar-runtime.mjs apply /physical/path/to/paperclip
node scripts/apply-native-avatar-runtime.mjs verify /physical/path/to/paperclip
node scripts/verify-native-avatar-worker.mjs fixed /physical/path/to/paperclip <外接卷>/<短测试临时目录>
```

`verify-native-avatar-worker.mjs` 是**生产 Mac mini 专用**的运行态核对：它要求临时目录以 `/Volumes/` 开头且不超过 80 字节（外接盘短路径，避免 Unix socket 路径过长），在开发机或非外接盘环境会直接拒绝；开发机只运行 `apply-native-avatar-runtime.mjs apply/verify`。

工具核对固定上游提交、相关源码 SHA、编译 worker SHA 和已构建 shared 模块，只原子替换 renderer import 为对应的 built JS 路径；拒绝未知构建或符号链接。上游重新构建会覆盖编译文件，须重新应用和验证。此修复与验证限定本次 macOS 原生部署，不宣称已验证 Docker 镜像。

### macOS 外接盘部署与缓存

生产部署把 `<部署根>` 放在 `<外接卷>` 上的项目目录；`~/.leophoneagent/paperclip` 仅作为兼容符号链接。源码、候选构建、Node/pnpm/Rust 运行时、工作空间、上传存储、配置、日志、数据库备份与旧版本归档均放在项目外接盘目录内。

外接盘需启用 macOS 文件所有权，项目目录只允许服务用户访问。文件所有权与 macOS 隐私授权是独立机制：SSH 能读取外接盘不代表 launchd 后台进程能读取。后台读取若返回 `Operation not permitted`，需由管理员在系统设置授予服务入口 `/bin/bash` 及该项目 Node 可执行文件适用的磁盘权限；配置也放在外接盘的现有 Cloudflare 隧道进程还需允许可移动磁盘访问，程序通常位于 Homebrew 的 `cloudflared` 安装目录；不要通过关闭系统隐私保护处理。LaunchAgent 使用系统 `/bin/bash` 入口、服务用户主目录作为初始工作目录；项目启动模板再进入实际工作目录，用户进程将日志重定向到外接盘，launchd 的初始标准输出使用 `/dev/null`。私有 `env/server.env` 设置 `PAPERCLIP_STORAGE_VOLUME` 和对应 `PAPERCLIP_STORAGE_VOLUME_UUID`。原生启动模板核对真实挂载点、卷 UUID、所有权和部署目录归属；验证失败则停止启动，不会在内置盘创建替代数据目录。

迁移时必须同时把 `PAPERCLIP_HOME`、`PAPERCLIP_CONFIG`、主密钥路径、config 的备份/日志/存储路径、智能体 `instructionsFilePath`/`instructionsRootPath` 与会话 `cwd`/`stateDir` 重定位到真实物理目录。兼容符号链接只用于旧入口；严格指令文件校验会拒绝任何经过符号链接的路径。更新前保存私有 env/config 和数据库字段快照，事务修改当前配置与会话路径，不重写历史消息、运行审计或权限；必须用真实任务验收，不能仅凭健康检查或模型 hello 判断迁移成功。

项目缓存环境按部署位置显式设置：`XDG_CACHE_HOME`、`npm_config_cache`/`NPM_CONFIG_CACHE`、`npm_config_store_dir`、`COREPACK_HOME`、`PYTHONPYCACHEPREFIX`、`CARGO_HOME` 和 `RUSTUP_HOME`。构建、测试与维护命令也须加载同一服务环境；仅设置 launchd 环境不会改变另一个 SSH shell 的缓存位置。已安装的共享 CLI 与账号认证保留其系统用户归属；不设置全局 `CODEX_HOME`，以免隐藏已登录账号。

上游稳定测试脚本使用独立、固定源码指纹的 `apply-test-storage.mjs` 叠层，支持 `PAPERCLIP_TEST_TMPDIR`。生产环境使用外接盘的短路径 `<外接卷>/<短测试临时目录>` 同时承载 `TMPDIR` 和测试临时根，避免嵌套路径过长影响 Unix socket。未配置该变量时，上游测试行为不变；显式配置但目录不存在时测试失败，不回退内置盘。`prepare.sh` 自动应用并核对这层修改，UI 汉化扫描范围仍限定原范围。

共享 Homebrew PostgreSQL 集群和用户级 CLI 认证不是本项目缓存，不迁移其他服务的数据库或账号。此部署的 Paperclip 数据库仍使用既有集群，数据库备份产物放到外接盘；若要迁移数据库本体，应单独迁移独立实例并验证恢复，不能只搬整个共享集群目录。

## 5. 权限、预算与数据

### 发行层 1.1.6 安全行为（无需新增环境变量）

- **子进程环境**：原生 CLI 状态探测、网页授权 PTY、本地/远程智能体执行、看板对话、工作区准备命令与 Cursor 模型探测，均剔除继承自服务器的私密变量（`DATABASE_URL`、`DATABASE_MIGRATION_URL`、`BETTER_AUTH_SECRET`、`PG*`、`*DATABASE_URL`、名称含 SECRET/KEY/TOKEN/PASSWORD/PRIVATE/CREDENTIAL 的 `PAPERCLIP_*`/`BETTER_AUTH_*` 等）；PATH、HOME、LANG、代理和各 CLI 自身配置保留。智能体配置里显式提供的不同取值不受影响。CLI 若确实需要某个数据库连接串，请在智能体配置中显式设置独立凭据，不要依赖继承服务器的。
- **响应头**：关闭 `X-Powered-By`；所有响应带 `X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`X-Frame-Options: SAMEORIGIN`；请求经 HTTPS（取决于 `TRUST_PROXY`）或 `PAPERCLIP_PUBLIC_URL` 为 https 时加 `Strict-Transport-Security: max-age=15552000`。未设置 CSP（未经逐页验收会破坏现有 UI）。
- **请求日志**：只记录请求 id、method、url、状态码与耗时，不再序列化完整请求/响应头；成功的 `GET /api/issues*`、`/api/companies*`、`/api/auth/get-session`、`/api/health` 降为 debug（排查时设 `PAPERCLIP_LOG_LEVEL=debug`），4xx/5xx 与写请求保持原级别。日志轮转仍需在系统层（如 newsyslog）配置。
- **CLI 状态接口**：同一服务环境下按适配器缓存 10 秒并合并并发请求；网页授权所用 CLI 路径按需解析（缓存 10 秒），运行期新装 CLI 无需重启。


- 通过“成员”和“实例访问权限”授权，遵循最小权限
- 新建智能体审批、预算强制停止仍按上游规则执行；中文按钮不会自动批准任何请求
- 预算以美元计价，数据库仍以美分存储；UTC 月度窗口含义不变
- 密钥页面的原始技术名称/ARN/路径需要保持精确；不要把中文标签作为环境变量名
- 显示错误时先给中文说明，“查看原始诊断”保留原始消息供排查；不要公开包含私人数据的诊断
- 上游可能包含遥测和 AI 反馈共享功能；部署前审阅上游隐私、遥测与实例设置，不应把中文化当作关闭这些功能的保证

## 6. 备份和回滚

发行层 1.1.6 起，数据库恢复先把归档完整解压到**备份文件同目录**下的私有临时目录（`.paperclip-restore-*`，0700，结束即删除；该目录不可写时才退回系统临时目录），并限制解压后字节数为 max(压缩大小×200, 8 GiB)，超过即中止且不触碰数据库。恢复前请确认备份所在卷有足够空间。

持久卷包含数据库、上传文件、工作空间和本地密钥材料。备份数据库时，必须同时保管恢复本地加密密钥所需的文件；单有数据库备份不足以保证密钥恢复。将备份存到访问受限的位置，按你的灾备策略验证恢复。

升级前：保存当前镜像 digest、数据快照、配置及中文层版本；在隔离环境验证数据库迁移和业务流程。回滚时使用已验证的旧镜像和相容数据备份；数据库迁移不保证可以直接降级。不要为了重装清空持久卷。

中文词库更新先重新生成、验收、构建新镜像，再由管理员执行发布。此代码提交本身没有执行上述生产操作。
