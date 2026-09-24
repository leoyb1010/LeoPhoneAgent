# ZCode 上游同步

- 当前上游:`29628c9a`(v3.14.3,2026-09-24 同步;上一次 `872ad960`,3.14.0)
- 引入方式:`git subtree add --prefix=src/mac/leophone https://github.com/zai-org/ZCode.git <sha> --squash`

## 同步
```bash
git -c core.hooksPath=/dev/null subtree pull --prefix=src/mac/leophone \
  https://github.com/zai-org/ZCode.git <新 sha> --squash
```
冲突只会出现在下面这几处(其余都是上游原样):

| 文件 | 我们改了什么 |
|---|---|
| `packages/desktop/scripts/desktop-product-identity.mjs` | 增加 `leo` 身份 |
| `packages/shared/src/env.ts` | `ZCODE_TELEMETRY_ENABLED = false` |
| `packages/desktop/src/main/autoUpdater.ts` | manifest 默认走 `LEO_UPDATE_MANIFEST_URL` |
| `packages/ui/src/Root.tsx` | 挂 `<LeoWhatsNew />` |
| `packages/ui/src/App.tsx`、`WindowsTopLeftLogo.tsx`、`components/ui/ZCodeAboutLogo.tsx` | 换标志 |
| `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts` | 文案里的产品名 |
| `packages/desktop/electron-builder.config.js` | extraResources 带上 `leo/` |
| `packages/desktop/src/host/index.ts` | 启动 Leo 层 |
| 根 `package.json` | 版本号与 `leo:*` 脚本 |
| `packages/shared/src/zcodeEndpoint.ts` | 官方 endpoint / BigModel / Z.ai OAuth / 业务 API 默认值全部指向 `http://127.0.0.1:9`,不内置官方 OAuth client id |
| `packages/shared/src/plugin-marketplaces.ts` | 官方市场远端分片指向死端口,只保留随包插件 |
| `packages/shared/package.json` | 导出 `./leo-network-guard` |
| `packages/desktop/src/main/index.ts`、`src/host/index.ts`、`src/scheduler/index.ts` | 第一行 import 网络兜底;main 在 ready 时装 session 拦截、导出 `ZCODE_HOME=~/.leophoneagent` |
| `packages/desktop/src/main/forceUpdateGuard.ts` | 官方远程强制升级直接放行 |
| `packages/desktop/src/main/remoteCdn.ts` | 不再默认官方 CDN(远程工作区运行时暂不可用) |
| `packages/desktop/src/main/{desktopDataBaseDirBootstrap,desktopRuntimeEnv,desktopCommandHandlers,exportLogs}.ts`、`index.ts` 的 settingsFile | `~/.zcode` → `~/.leophoneagent` |
| `packages/desktop/src/main/{desktopOAuthDeepLink,desktopDeepLinkUrl,desktopFinderOpenFolderWorkflow}.ts` | URL scheme `zcode` → `leophoneagent` |
| `packages/desktop/electron-builder.config.js` | scheme、版权行、updater 缓存目录名、随包 ZCode LICENSE/NOTICE、嵌套二进制补签 |
| `packages/services/src/oauth/runtimeConfig.ts` | 官方 OAuth provider 列表置空 |
| `packages/services/src/conversation-share/conversationShareService.ts` | 分享 / 导入入口直接拒绝 |
| `packages/services/src/{subagents/subagentStorage,subagents/subagentsService,plugin-sync/pluginSyncService,runtime-tools/providerRuntimeResolver}.ts` | 用户级 `~/.zcode` → `~/.leophoneagent` |
| `packages/services/src/{paths,node}.ts` | 数据根 `~/.leophoneagent` |
| `packages/ui/src/WelcomeScreen.tsx` | 去掉官方登录入口,加「用订阅账号登录」 |
| `packages/services/src/{coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider,client-config/clientConfigService,client-scenes/clientScenesService}.ts` | 官方 client/configs、client/scenes 本地给空配置,不发请求(闲时任务关、强制升级无、灰度走本地默认) |
| `packages/shared/src/dynamic-workflow-feature.ts` | 动态工作流本地默认 `onDemand` |
| `packages/services/src/**` 其余用户级路径(settings、settings-sync、skills、commands、hooks、mcp-sync、skill-sync、device、telemetry、storage roots、agent 日志/轨迹/插件管理目录) | `~/.zcode` → `~/.leophoneagent`;工作区级 `<项目>/.zcode/*` 不动 |
| `packages/shared/src/zcode-agent-runtime.ts` | `nativeConfigDir` → `.leophoneagent/cli` |
| `packages/desktop/src/main/mcpUserDirectory/*` | MCP 用户目录 → `~/.leophoneagent/cli` |
| `packages/desktop/src/main/{desktopApplicationMenu,desktopCommandHandlers}.ts` | 去掉「反馈」菜单;「更新日志」打开 leocodebox-updates 发布页 |
| `apps/zcode-cli/**`(约 35 个文件) | 官方 OAuth / 换 Key / 官方网关改写 / 远程供应商目录 / 官方市场 / 官方 MCP 信任 / 遥测全部切断;用户级数据根 `~/.leophoneagent`;`packages/cli/src/main.ts` 第一行 import 网络兜底 |
| `packages/ui/src/**`(约 34 个文件) | 账号头像与套餐、升级、反馈、分享、官方文档/社区、智谱模板、CDN 图标与官方插件入口移除;设置 → 模型供应商加订阅登录按钮;Root 在欢迎页后按请求打开模型设置 |

新增文件(零冲突):`packages/ui/src/leo/`、`packages/desktop/src/host/leo/`、
`packages/desktop/leo/`、`packages/desktop/src/main/{leoUpdateFeed,leoSessionGuard,leoEarlyEnv}.ts`、
`packages/shared/src/leoNetworkGuard.ts`、`scripts/leo-*`。

**独立性红线(同步上游后逐条复查)**:不连任何 `*.z.ai / bigmodel.cn / zhipuai.cn / zcode.ai`;
不读 `~/.zcode`;不接官方账号;更新只走 `leocodebox-updates`。上游新增的联网点,
网络兜底会拦下并在日志里留下「属于官方服务,LeoPhoneAgent 不连接」,按日志补源头。

已删除的上游文件(同步时若上游改了它们,按删除处理):`packages/ui/src/login/LoginApiKeyForm.tsx`、
`packages/ui/src/login/LoginApiKeyForm.helpers.ts`、`packages/ui/src/onboarding/assets/feishu.png`。

同步后必须跑:typecheck、lint、architecture:check、`leo:bundle:mac` 冒烟。

## v3.14.3 同步记录(2026-09-24,Mac 1.1.0)
- 上游 283 个文件:87 个新增、176 个原样取上游、17 个自动三方合并、3 个冲突(根 `package.json` 取我们的;`contracts/src/tools/save-workflow.ts` 取上游,新文案已不含 `~/.zcode`;`packages/ui/src/WorkspaceSidebarFooter.tsx` 手工合:保留我们删掉用量摘要后的 import,补上游的 `WorkspaceWebRemoteControlTrigger`,并恢复 `workspacePath`/`workspaceIdentity` 两个解构参数)。
- 新增补丁,下次同步要复查:
  - `packages/services/src/bots/{messages,feishuChannelRuntime,telegramChannelRuntime,weixinChannelRuntime}.ts`:回复与提示里的 ZCode 改成 LeoPhoneAgent。
  - `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`:新增的机器人文案里的 ZCode 改名(14 行)。
  - `packages/desktop/electron-builder.config.js`:`extraMetadata.homepage/author` 与 `linux.maintainer` 不再写官方网址和邮箱。
  - 根 `package.json` 的 `leo:bundle:mac`:固定打开签名(`ZCODE_ENABLE_MAC_SIGN=1`,默认身份 `leo yuan (48H5Y3LNUK)`),不签名就打不出包。
- 上游 3.14.3 把机器人任务硬锁成 yolo(`services/src/bots/botsService.ts` 的 `BOT_FORCED_MODE`),M1b 会改成 build 并加工具规则,到时记在这里。

## Mac 1.2.0 补丁(2026-09-25,M1b)
- `packages/services/src/bots/botsService.ts` 两处,同步时必须保留(`services/test/leoBotPolicy.test.ts` 会拦):
  - `const BOT_FORCED_MODE = LEO_BOT_FORCED_MODE;` —— 机器人任务改为 build,不再免审批。
  - 权限卡片的选项先过 `filterBotPermissionOptions(event, context.workspacePath)`:聊天里只能批只读工具与工作区内改文件,其余只能拒绝,不给项目级「总是允许」。三处 `respondPermission` 都只认这里留下的选项。
  - 规则本体在我们自己的 `packages/services/src/bots/leoBotPolicy.ts`。
- `packages/desktop/src/host/leo/link/` 整个目录是我们的(手机桥接 Leo Link),不涉及上游文件。
- 自建的 `packages/desktop/src/host/leo/telegram.ts` 已删除,Telegram 改走上游机器人。

## Mac 1.2.1 补丁(2026-09-25)
- `apps/zcode-cli/packages/core/src/permission/service.ts` 的 `checkAlwaysAsk`:在硬禁用、auto 保护、项目 deny 之后,
  yolo(界面叫「完全访问」)且非 plan 时直接放行 alwaysAsk 工具(工作流的创建 / 保存 / 修改)。上游在 yolo 下仍会问;
  同步时保留这一段(标了 `[leo]`)。
