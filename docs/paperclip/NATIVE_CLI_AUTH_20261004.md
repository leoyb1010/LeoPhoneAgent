# Mac mini 原生 CLI 状态与网页授权修复

日期：2026-10-04。Paperclip 固定上游 `994d6edcdd4e15d5f9cc5cf8c135ac599104b86a`，发行层 1.1.0。公网入口仍为 `https://paperclip.leoyuan.top`，原生服务仅监听回环 `43871`。

## 根因

访问域名不是原来的拒绝条件。上游本地主机订阅策略按 authenticated/public 部署配置关闭，浏览器 PTY 能力仅接 sandbox；原生主机没有授权 transport。新建向导忽略已有 Codex auth-signal，Claude 原生 OAuth 状态未被读取，其他 CLI 缺状态元数据。已有配置页还有一个环境列表加载门禁：未启用实验性环境选择器时不读取本地环境，因而隐藏重新授权入口。

## 改动

- 独立 `PAPERCLIP_NATIVE_CLI_LOGIN_ENABLED=true` 启用受控 Mac 主机授权；health 新增 `nativeAdapterLoginSupported`，不改原终端登录策略，不打开 MCP 信任。
- 安装与认证状态分开：Codex/Claude 调用固定只读状态命令；其他没有可靠状态命令的 CLI 显示未知，凭据文件或 API key 存在不等于认证有效。支持已注册的本地 CLI 名称及 Cursor 历史别名。
- 新建、引导、连接账号、现有配置页统一 native capability；已有 CLI 可复用，新授权与重新授权提供独立私有会话。默认环境读取与实验性选择器展示分离。
- 固定 CLI/argv、真实 macOS PTY、私有目录与安全凭据读取；剥离新授权子进程的既有认证变量，保留代理。取消、父进程断开、独立 deadline watchdog、重启及生产 reaper 正确清理 native 资源。
- native 启动要求 instance admin、公司权限、稳定 owner、活动 local 环境与明确 subscription intent；仅复用既有 AI connection 机制提升凭据，不写回 operator 全局认证。新授权显式采用后才修改配置。

## 验证

- 中文及源代码叠层 Node 测试 49/49、0 跳过；后端路由、权限和生产清理针对测试 35/35。
- 新建／托管账号真实 React 回归 11/11；生产形态已有 Codex 表单回归 2/2；UI/server TypeScript、600 文件协议检查和完整生产构建通过。
- Native PTY 隔离验证包括真正 terminal、固定参数、凭据安全、取消、EOF 与独立 deadline；这些不是实际提供商账号授权。
- 公网已真实读取服务器 Claude 登录，界面显示“已读取服务器 CLI 登录”。Claude 新授权实际返回授权链接与代码输入入口；未替用户完成 Claude 账号授权。
- Codex 公网生成设备授权提示。最初演示会话超时，用户另开新会话在 24 秒内完成，服务端记录 authenticated 并保存连接。已通过界面将该连接绑定原智能体，真实模型测试返回连接成功。
- 真实新凭据任务 `LEO-7`「Codex 重新授权完整执行验收」由同一智能体自行评论 `NATIVE_CLI_REAUTH_OK` 并完成，40 秒、3 次工具调用，未手动标记完成。

## 提供商验收边界

Grok 的真实网页启动最初两次 CLI 快速退出，之后公开域名实测成功显示登录链接与验证码；同版 CLI 在隔离启动也能出现设备提示。未取得早期失败的固定原因，不能声称提供商启动从此不会失败。新增失败诊断仅输出固定类别/白名单词，不记录原始流；授权失败、超时和取消可直接“重新开始授权”，真实面板 6/6 回归及生产构建通过。

Codex 完成了真实授权、凭据保存、绑定、模型响应和任务执行。Claude 已验证本地登录读取及真实授权链接/输入码，Grok 已验证真实网页登录提示；未经账号本人完成的 Claude/Grok 授权，不计入授权完成或模型可用证据。

所有项目产物、运行时、日志、缓存与私有认证会话仍在 Mac mini 外接盘。共享 PostgreSQL 集群和 operator 用户级认证保持系统归属。原有账号未因授权失败或取消被覆盖；原始终端流、验证码、授权 URL 参数和 token 不进入交付文档或源码。
