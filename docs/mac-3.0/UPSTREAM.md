# ZCode 上游同步

- 当前上游:`872ad960de7ec172591f7e1952f7849229f94521`(3.14.0,2026-09-21)
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

新增文件(零冲突):`packages/ui/src/leo/`、`packages/desktop/src/host/leo/`、
`packages/desktop/leo/`、`packages/desktop/src/main/{leoUpdateFeed,leoSessionGuard,leoEarlyEnv}.ts`、
`packages/shared/src/leoNetworkGuard.ts`、`scripts/leo-*`。

**独立性红线(同步上游后逐条复查)**:不连任何 `*.z.ai / bigmodel.cn / zhipuai.cn / zcode.ai`;
不读 `~/.zcode`;不接官方账号;更新只走 `leocodebox-updates`。上游新增的联网点,
网络兜底会拦下并在日志里留下「属于官方服务,LeoPhoneAgent 不连接」,按日志补源头。

同步后必须跑:typecheck、lint、architecture:check、`leo:bundle:mac` 冒烟。
