# ZCode 上游同步

- 当前上游:`aac47556`(v3.15.1,2026-10-17 同步,WP-11;上一次 `29628c9a`,v3.14.3)
- subtree 同步点:squash 提交 `6914fec0`(`git-subtree-split: aac47556`),合并提交 `de29cde3`;下次 `subtree pull` 直接接上。
- 引入方式:`git subtree add --prefix=src/mac/leophone https://github.com/zai-org/ZCode.git <sha> --squash`

## 同步
```bash
git fetch https://github.com/zai-org/ZCode.git <tag>          # 或已有本地引用 refs/zcode/vX.Y.Z
git -c core.hooksPath=/dev/null -c merge.renames=false \
  subtree merge --prefix=src/mac/leophone --squash <新 commit>   # 关掉 rename 检测,免得把上游改动套到我们新增的文件上
cd src/mac/leophone
node scripts/leo-upstream-delete.mjs --apply    # 先把删除面清掉(modify/delete 冲突 + 已删目录里的新增文件)
# ……解冲突(三方版本:git show :1:/:2:/:3:<path>)……
node scripts/leo-upstream-delete.mjs --check    # 删除面没有回潮
node scripts/leo-redline-check.mjs              # 红线:源码 0 命中
node scripts/leo-upstream-delete.mjs --generate <新 commit>   # 收尾:按「上游有、我们没有」重写清单
```
删除清单 `src/mac/leophone/scripts/leo-upstream-delete-list.txt`:一行一个路径,`dir/` 表示整目录
(上游以后在其中新增的文件也删)。红线闸门 `scripts/leo-redline-check.mjs` 挂在 `leo:bundle:mac` 链首,
打包后再扫一遍产物(含 .app 里的 app.asar)。

冲突只会出现在下面这几处(其余都是上游原样):

| 文件 | 我们改了什么 |
|---|---|
| `packages/desktop/scripts/desktop-product-identity.mjs` | 增加 `leo` 身份 |
| `packages/shared/src/env.ts` | 遥测 / ARMS 上报端点恒为空(3.15.1 删了 `ZCODE_TELEMETRY_ENABLED`,改为「端点为空即关」);`ZCODE_AUTO_UPDATE_ENABLED` 走构建期注入 |
| `packages/desktop/src/main/autoUpdater.ts` | manifest 默认走 `LEO_UPDATE_MANIFEST_URL` |
| `packages/ui/src/Root.tsx` | 挂 `<LeoWhatsNew />` |
| `packages/ui/src/App.tsx`、`WindowsTopLeftLogo.tsx`、`components/ui/ZCodeAboutLogo.tsx` | 换标志 |
| `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts` | 文案里的产品名 |
| `packages/desktop/electron-builder.config.js` | extraResources 带上 `leo/` |
| `packages/desktop/src/host/index.ts` | 启动 Leo 层 |
| 根 `package.json` | 版本号与 `leo:*` 脚本 |
| `packages/shared/src/zcodeEndpoint.ts` | 官方 endpoint / BigModel / Z.ai OAuth / 业务 API 的 `DEFAULT_*` 与 3.15.1 新增的 `TEST_*`、`CODING_PLAN_LOCAL_WEBVIEW_ORIGIN` 全部指向 `http://127.0.0.1:9`,Web 远控中继 `ws://127.0.0.1:9/ws`,不内置官方 OAuth client id |
| `packages/shared/src/plugin-marketplaces.ts` | 官方市场远端分片指向死端口,只保留随包插件 |
| `packages/shared/package.json` | 导出 `./leo-network-guard` |
| `packages/desktop/src/main/index.ts`、`src/host/index.ts`、`src/scheduler/index.ts` | 第一行 import 网络兜底;main 在 ready 时装 session 拦截、导出 `ZCODE_HOME=~/.leophoneagent` |
| `packages/desktop/src/main/forceUpdateGuard.ts` | 官方远程强制升级直接放行 |
| ~~`packages/desktop/src/main/remoteCdn.ts`~~ | 3.15.1 起随 SSH/WSL/Docker 远程工作区整体删除 |
| `packages/desktop/src/main/{desktopDataBaseDirBootstrap,desktopRuntimeEnv,desktopCommandHandlers,exportLogs}.ts`、`index.ts` 的 settingsFile | `~/.zcode` → `~/.leophoneagent` |
| `packages/desktop/src/main/{desktopOAuthDeepLink,desktopDeepLinkUrl,desktopFinderOpenFolderWorkflow}.ts` | URL scheme `zcode` → `leophoneagent` |
| `packages/desktop/electron-builder.config.js` | scheme、版权行、updater 缓存目录名、随包 ZCode LICENSE/NOTICE、嵌套二进制补签 |
| `packages/services/src/oauth/runtimeConfig.ts` | 官方 OAuth provider 列表置空 |
| ~~`packages/services/src/conversation-share/conversationShareService.ts`~~ | 1.9.0 起整个分享 / 导入模块已删除,见文末「Mac 1.9.0：删除的上游模块」 |
| `packages/services/src/{subagents/subagentStorage,subagents/subagentsService,plugin-sync/pluginSyncService,runtime-tools/providerRuntimeResolver}.ts` | 用户级 `~/.zcode` → `~/.leophoneagent` |
| `packages/services/src/{paths,node}.ts` | 数据根 `~/.leophoneagent` |
| `packages/ui/src/WelcomeScreen.tsx` | 去掉官方登录入口,加「用订阅账号登录」 |
| `packages/services/src/{client-config/clientConfigService,client-scenes/clientScenesService}.ts` | 官方 client/configs、client/scenes 本地给空配置,不发请求(闲时任务关、强制升级无、灰度走本地默认);原 `coding-plan-subscription/` 已删,开关改由 `feature-config/` 本地裁决,见文末 |
| `packages/shared/src/dynamic-workflow-feature.ts` | 动态工作流本地默认 `onDemand` |
| `packages/services/src/**` 其余用户级路径(settings、settings-sync、skills、commands、hooks、mcp-sync、skill-sync、device、telemetry、storage roots、agent 日志/轨迹/插件管理目录) | `~/.zcode` → `~/.leophoneagent`;工作区级 `<项目>/.zcode/*` 不动 |
| `packages/shared/src/zcode-agent-runtime.ts` | `nativeConfigDir` → `.leophoneagent/cli` |
| `packages/desktop/src/main/mcpUserDirectory/*` | MCP 用户目录 → `~/.leophoneagent/cli` |
| `packages/desktop/src/main/{desktopApplicationMenu,desktopCommandHandlers}.ts` | 去掉「反馈」菜单;「更新日志」打开 leocodebox-updates 发布页 |
| `apps/zcode-cli/**`(约 35 个文件) | 官方 OAuth / 换 Key / 官方网关改写 / 远程供应商目录 / 官方市场 / 官方 MCP 信任 / 遥测全部切断;用户级数据根 `~/.leophoneagent`;`packages/cli/src/main.ts` 第一行 import 网络兜底 |
| `packages/ui/src/**`(约 34 个文件) | 账号头像与套餐、升级、反馈、分享、官方文档/社区、智谱模板、CDN 图标与官方插件入口移除;设置 → 模型供应商加订阅登录按钮;Root 在欢迎页后按请求打开模型设置 |
| `apps/zcode-cli/packages/contracts/src/tools/{index,edit,read}.ts` | 导出 `leo-edit.js`;`EditOutput` 加可选 `leo` 摘要(段数 / 匹配策略 / hashline 预览);`ReadTextOutput` 加可选 `lineFormat` |
| `apps/zcode-cli/packages/core/src/index.ts` | 导出 `tool/leo/index.js`(Leo agent 档位 API) |
| `apps/zcode-cli/packages/core/src/tool/handlers/edit.ts` | 入参走 `LeoEditInputSchema`(单段 / `edits[]` / hashline 锚点 / 参数修复);多段与锚点交 `leo/edit-plan`;BOM 剥离后匹配再拼回;按文件写队列;匹配策略计数;hashline 模式结果附新锚点 |
| `apps/zcode-cli/packages/core/src/tool/handlers/write.ts` | handler 套按文件写队列 |
| `apps/zcode-cli/packages/core/src/tool/edit-matchers.ts` | exact 之后插入 `hashline_prefix_stripped` / `unicode_normalized` 两级窄匹配 |
| `apps/zcode-cli/packages/core/src/tool/handlers/{read,read-text}.ts` | 文本读取按模型走 hashline / 无行号窗口(2000 行 / 50KB);窗口按 range view 记 read-state;hashline 模式编辑后重读不回“未变”占位 |
| `apps/zcode-cli/packages/core/src/tool/handlers/index.ts` | 注册选项加 `leoAgent`;Edit / Read 用 `withLeoModelProfile` 包装 |
| `apps/zcode-cli/packages/core/src/tool/provider-visible-order.ts` | 非内置工具按名排序、码点比较(prompt cache 稳定) |
| `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts` | `tool.call.completed` 日志加 `editMatchStrategies` |
| `apps/zcode-cli/packages/core/src/runtime/{types,helpers/runtime-tools,methods/embedded-search-branch,methods/subagent}.ts` | `AgentRuntimeConfig.leoAgent` 及其透传 |
| `apps/zcode-cli/packages/core/src/runtime/{helpers/tool-allowlist,methods/mcp,methods/context}.ts` | 精简档:核心工具白名单、不注册 MCP、最小系统提示词 |
| `apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts` | 记本步输出预算;过早 length 截断先压缩重试;超窗 / 丢弃的尝试收尾并对 provider 隐藏 |
| `apps/zcode-cli/packages/core/src/runtime/{methods/message-persistence,internal-turn-methods}.ts`、`agent/session-history-hydrator.ts` | assistant 消息可标 `providerVisibility: "hidden"`,冷恢复跳过 |
| `apps/zcode-cli/packages/adapters/src/model/model-execution.ts` | OpenAI 系 fetch 套 `prompt_cache_key`;openai-compatible 用 `convertLeoOpenAICompatibleUsage` |
| `apps/zcode-cli/packages/bootstrap/src/app/{runtime-config,create-app}.ts` | 读 `leo` 档位进 `runtimeConfig.leoAgent`;非法字段记 warning;model adapter env 注入合并后的 `ZCODE_LEO_AGENT` |
| `packages/provider/src/{config-service,config/provider-config}.ts` | 无模板新建供应商显式写 `api.type = openai-chat-completions`;本机 OpenAI 兼容端点豁免 apiKey 必填(见 `docs/specs/leo-model-discovery.md`) |
| `packages/services/src/model-provider/{providerFacadeServices,providerRuntime}.ts`、`node.ts` | `IProviderSettingsService.discoverModels` / `importProviders` 与装配(新增 `providerModelDiscovery.ts`、`modelsDevCatalog.ts`) |
| `packages/ui/src/settings/model-provider-section/{ProviderCardSections,InlineEditableProviderCard,ApiKeyInput,ProviderModelMetadataDialog}.tsx`、`ProviderDraftSave.ts`、`lib/modelSelectionGroups.ts`、`ModelConfigSelect.tsx` | 「从接口获取模型」入口、默认格式、Key 标红、ID 候选;选择器显示美化名 |
| `packages/shared/package.json` | 导出 `./model-discovery`、`./provider-import` |
| `packages/ui/src/settings/ModelProviderSection.tsx`、`model-provider-section/SectionLayout.tsx` | 「从 iPhone 导入」入口(`headerExtra`;新增 `ProviderImportButton.tsx`、服务侧 `iosProviderImport*.ts`,见 `docs/specs/leo-provider-import.md`) |

新增文件(零冲突):`packages/ui/src/leo/`、`packages/desktop/src/host/leo/`、
`packages/desktop/leo/`、`packages/desktop/src/main/{leoUpdateFeed,leoSessionGuard,leoEarlyEnv,leoLinkIpc}.ts`、
`packages/desktop/src/preload/leoBridge.ts`、
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

## Mac 1.3.0 补丁(2026-09-26,界面换皮 + 扫码连手机)
- 皮肤层全在 `packages/ui/src/leo/skin/`(变量覆盖 + 稳定钩子),由 `leo/LeoWhatsNew.tsx` 引入;不改 `styles.css` 令牌块和 `components/ui/*`。
  依赖的上游钩子:`.chat-composer-input-surface form > .rounded-2xl`(输入卡)、`[data-testid="v4-stop"]`(在跑)、
  `[data-testid="v4-composer-send"]`、`.theme-zai-{dark,light}`。同步后这几个选择器若失效,皮肤只是退回上游外观,不会坏功能。
- 上游文件(都标了 `[leo]`):
  - `packages/ui/src/v4/ConversationDraftEmptyState.tsx`:去掉大号线框水印,问候上方放实心 `LeoMark`。
  - `packages/ui/src/v4/SessionPane.tsx`:草稿页输入框下方挂 `LeoDraftStatusList`(等你确认 / 在跑 / 做完待看)。
  - `packages/ui/src/App.tsx`:最外层包 `LeoHomeProvider`(已打开项目 + 打开任务)。
  - `packages/ui/src/WelcomeScreen.tsx`:图标不再外套深色方块(`onboarding/OnboardingWelcomeView.tsx` 已在 Mac 1.9.0 删除)。
  - `packages/ui/src/WebRemoteControlDialog.tsx`:最前面挂 `LeoPhoneLinkSection`(连接状态 + 扫码加手机)。
  - `packages/desktop/src/renderer/index.html`:启动标志改为安静浮现,不回弹。
  - `packages/ui/src/openWorkspacePageThemeHero.tsx`:两套 Zai 主题的欢迎背景从智谱蓝换成暖色 + 青绿。
  - `packages/ui/src/PermissionDialog.tsx`:根节点加 `data-leo-approval`,皮肤层据此做审批卡滑入。
  - `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`:`webRemoteControl.description` 改成「手机 App 或聊天机器人」。
  - `packages/desktop/src/main/index.ts`:ready 时 `registerLeoLinkIpc()`。
  - `packages/desktop/src/preload/index.ts`:引入 `./leoBridge.js`(暴露 `window.leoLink`)。

## Agent 编码能力补丁(2026-09-26)
- 上游文件改动见上表 `apps/zcode-cli/...` 各行,改动处都标了 `[leo]`。`pnpm leo:test:agent` 里的
  `core/test/leo/runtime-hooks.test.ts` 会检查这些钩子还在,同步上游把它们冲掉时会红。
- 新增文件(零冲突):`contracts/src/tools/leo-edit.ts`、`core/src/tool/leo/`、`core/src/runtime/leo/`、
  `adapters/src/model/leo-prompt-cache.ts`、`bootstrap/src/app/leo-agent-config.ts`、`*/test/leo/`(以上都在 `apps/zcode-cli/packages/` 下)、
  `scripts/leo-eval/`(eval 工具,见其 README);根 `package.json` 加 `leo:test:agent`、`leo:eval`。
- 配置:`~/.leophoneagent/cli/config.json`(或项目 `zcode.json` / `.zcode/config.json`)的 `"leo"` 段,环境变量 `ZCODE_LEO_AGENT`(同结构 JSON)优先:
  `{"editMode":{"default":"replace","models":{"*glm*":"hashline"}},"readLineNumbers":{"default":true,"models":{}},"leanProfile":false,"promptCacheKey":true}`。
  内置默认:所有模型都走 replace(`"hashlineFamilies": true` 才让 GLM / Kimi / MiniMax 走 hashline,评测台在真实模型上跑出提升再考虑默认打开);行号默认保留;精简档默认关;`prompt_cache_key` 默认只发给 api.openai.com / openrouter.ai。

## Mac 1.3.3 补丁(2026-09-27,OpenCode Go)
- 上游配置 `config/provider/zcode-builtin.json`(revision 31):`opencode-go-chat` / `-responses` 两个模板补齐
  opencode.ai/v2/docs/console/go 端点表里的全部模型(共 34 个),新模型的 `templateModelRules` / `providerSiteRules`
  照同模板已有条目写。同步上游时这几条若被冲掉,只是「模型供应商」里少几个模型,不影响能否调用。
- 新增文件(零冲突):`packages/desktop/src/host/leo/openCodeGoModels.ts`(+ `.test.ts`):「订阅账号」里的 OpenCode Go
  以官方实时列表为准,去掉已下线模型,MiniMax / Qwen 按文档走 Anthropic Messages;`openCodeSessionHeaders()`
  给经模型代理(`modelProxy.ts`)发往 opencode.ai 的请求补 `x-opencode-session`(Go 不带会拒,400 MissingSessionID)。
  上游 Agent 自己的请求头在 `apps/zcode-cli/packages/adapters/src/model/runner-attribution.ts`,本来就带,无需改动。

## Mac 1.9.0：删除的上游模块

同步上游时以下文件按删除处理,改动处按「编程模式」取上游另一分支:
- 首启职业 / 模式引导:`packages/ui/src/onboarding/{OccupationOnboarding,OccupationOnboardingVisual,OnboardingOccupationGrid,OnboardingModeSelector,OnboardingHeader,OnboardingMeshBackground,OnboardingWelcomeView,OnboardingWelcomeAsciiVisual}.tsx`、`{occupationOptions,onboardingMeshRenderer,useOnboardingTrigger,useOnboardingTelemetry}.ts`、`onboardingLogoSweep.css`、`onboarding/assets/`;引导记录服务 `packages/services/src/onboarding/`、`packages/shared/src/onboardingRecord.ts`、`packages/ui/src/hooks/useOnboardingRecordService.ts`(channel `onboarding-record` 不再注册,磁盘上的旧记录文件不读不写不删)。store 去掉 `newUserOnboardingOpen`,快捷键去掉 `openOnboarding`;`Root.tsx` 不再包 `<OccupationOnboarding>`。
- 保留 `onboarding/OnboardingDialog.tsx` 作「迁移向导」(Claude Code 会话 / Skills / MCP / 命令 / CLAUDE.md→AGENTS.md),去掉欢迎页,只从 设置 → 常规 打开;设置侧栏的「引导」按钮删除。
- 界面模式(编程 / 办公):`packages/ui/src/lib/interfaceMode.ts`、`hooks/useInterfaceMode.ts`、`settings/ProactiveSuggestionsSetting.tsx`、`WorkspacePluginPreview.tsx`、`v4/featureSuggestedPrompts.ts`、`v4/featureSuggestedPromptRotation.ts`;store 的 `interfaceMode`、快捷键 `toggleInterfaceMode`、头像菜单与常规设置里的切换、各组件的 `isOfficeMode` 分支全部按编程模式写死。localStorage `zcode-interface-mode` 与 settings 里的 `proactiveSuggestionsEnabled` 不再读取。
- 画板与 Treemapping 侧栏:`packages/ui/src/{WhiteboardPane,TreemappingPane}.tsx`、`lib/{whiteboard,treemappingActivity}.ts`、`store/whiteboardStore.ts`、`mentions/providers/whiteboardMentionProvider.ts`、`v4/useTreemappingConversationMessage.ts`;`@` 面板去掉「画板」分组。`lib/workspaceSidePane.ts` 恢复状态时丢弃旧的 `whiteboard` / `treemapping` tab。
- 聊天机器人遥控(Telegram / 飞书·Lark / 微信 / Webhook)整体删除,产品不接入飞书:`packages/services/src/bots/**`(含 `leoBotPolicy.ts`、`botRemoteWorkspaceBridge.ts`)与 `services/test/leoBotPolicy.test.ts`、`packages/shared/src/bots.ts`、`packages/ui/src/{BotsDialog.tsx,BotsDialog/,botsUi.ts,WebRemoteControlDialog.tsx,WorkspaceWebRemoteControlTrigger.tsx}`、`ui/src/root/{useBotBroadcastEffects,botsTaskBroadcast,botsTaskStreamBroadcast}.ts`、`ui/src/assets/channel-icons/`、`desktop/src/host/cronBotDelivery.ts`;i18n 的 `bots.*`、`webRemoteControl.*` 全删。
- 随之删除的接线:`IBotsService` / channel `bots`(services node/index/accessor、client `remoteServiceAccess`、desktop `remoteWorkspaceServiceCollection`)、server `POST /api/bots/:provider[/:botId]`、host↔main 的 `bot-remote-workspace-*` 消息与 `PlatformChannels.BotRemoteWorkspaceReconnected`(validation / channels / platform / preload / renderer / web 平台桩 / `desktopRemoteSessions` / `desktopHostProcess` / `useRemoteWorkspaceHistory`)、Bot 运行时偏好同步(`Root.tsx`、`useSettingService.ts`)。
- 定时任务的 Bot 回推:协议字段 `botDeliveryTarget`(`zcode-protocol` 两处 + v4 `sendText`)、`ZCodeAutomationCreateParams.botDeliveryTarget`、CLI 的 `activeBotDeliveryTarget` 全删;tasks 库的 `automations.bot_delivery_target` 列保留(不迁移用户数据),新建任务一律写 NULL。
- 依赖与打包:`@larksuiteoapi/node-sdk`(desktop、services、tsup/bundle/electron-builder 外置名单)、`lark-cli` 运行时工具与 `ZCODE_LARK_CLI_BINARY` 环境变量;`config/default.json` 去掉飞书反馈表单与飞书社群链接,README 去掉飞书社群。
- (3.15.1 更新:下面说的 `packages/server`、`packages/web`、远程会话 / 连接注册表已在 WP-11 删除,见文末「v3.15.1 同步记录」。)
- 保留:Leo Link 依赖的 attachment 层(`deliveryKind: "bot-channel-continuous"` 只是投递语义名,不是机器人模块)与 `/remote` Web 远控基础设施(`packages/server`、`packages/web`、`web-remote-replayable`)。上游的「移动端远程控制」弹层不再存在,侧栏手机图标改为打开 设置 →「连接手机」(`settings` 分区 `phone`,内容是 `leo/LeoPhoneLinkSection.tsx` + `leo/DirectConnectionSettings.tsx`)。同步时上游对 `WebRemoteControlDialog` / `WorkspaceWebRemoteControlTrigger` 的改动一律丢弃。
- `settings/SettingsPageParts.tsx` 的 `SettingsRow` / `SettingsGroupCard` 挪到 `settings/SettingsRow.tsx`(原文件 re-export),让手机页与 `scripts/audit-phone-link` 隔离夹具不拖入代码预览依赖。
- 会话分享 / 导入(官方分享服务,入口早已撤下):`packages/services/src/conversation-share/**`、`packages/shared/src/conversation-share.ts`、`packages/ui/src/ConversationSharePermissionPicker.tsx`、`packages/ui/src/v4/{ConversationShare*.tsx,conversationShare*.ts,useConversationShareSelectionOutsideDismiss.ts,ConversationBottomDockTransition.tsx}`、`ui/src/store/conversationShareSelectionStore.ts`、`ui/src/lib/{conversationShareContext,conversationShareError}.ts`、`ui/src/root/shareImportIntent.ts`、`packages/web/src/share/**`(分享落地页与 `/share` 路由)、`packages/desktop/src/host/conversationShareAttachmentService.ts`;`@zcode/ui` 的 `./conversation-share-readonly` 导出。接线:channel `conversation-share`(services node/index/accessor、client、host attachment 覆盖、`remoteWorkspaceServiceCollection`、renderer `remoteWorkspaceSessionServices`)、`leophoneagent://share/import` deep link(`desktopDeepLinkUrl` / `desktopOAuthDeepLink` / preload / `PlatformChannels.ShareImport` / `IPlatformService.onShareImport`)、Root 的导入流程(`useRootPlatformEffects`)、`seedImportedSessionDraft`、session store 的 `timelineBottomRequest`、SessionPane / Timeline / TurnGroup / Composer / RowView 里的分享勾选与 `sharedContextRefs` 注入;i18n `conversationShare.*`。协议里的 `sharedContextImport` / `context_refs` 字段(CLI 共用)保留,桌面端不再产生。
- 反馈中心(问题上报 / 工单,官方反馈服务):`packages/ui/src/feedback/**`、`ui/src/lib/{taskFeedbackDraft,errorFeedbackDraft}.ts`、`packages/services/src/feedback/**`、`packages/shared/src/{feedback,feedbackPrivacy}.ts`。接线:channel `feedback`、`IServiceAccessor.feedbackService`、Root/App 的 `baseFeedbackService`、任务右键 / 头部菜单的 `onOpenTaskFeedback`、命令面板 `feedback`、`IPlatformService.{openFeedback,onOpenFeedbackDialog,onOpenTicketsPanel}`、`DesktopCommandIds.OpenFeedback`、`PlatformChannels.{OpenFeedbackDialog,OpenTicketsPanel}`、host↔main 的 `feedback-log-archive-*` 消息与 `exportLogs.createFeedbackLogArchiveFromExportLogs`、hostInit 的 `feedbackApiBase`、`remoteAppConfig` / `helpAppConfig` 的 feedback 字段、`desktopMenu` 的 `helpFeedback`;i18n `feedback.*`(只留聊天报错「复制报错」用的 4 个 `feedback.submit.template.section.*`)。`storageCatalog` 里的 `feedback` 目录登记保留,用于清理用户已有的旧数据。
- SSH / WSL / Docker 远程工作区的**新建入口**:`packages/ui/src/{SSHDialog,RemoteConnectionDialogContent,RemoteConnectionFields,RemoteConnectionWizardChrome}.tsx`、`ui/src/remote-connection/**`、`ui/src/hooks/{useRemoteConnectionForm,useCancelPendingRemoteConnection,useRemoteConnectionEntryVisibility}.ts`、`ui/src/lib/{remoteConnectionDialogState,remoteConnectionDockerOptions,remoteConnectionWizard,wslUncWorkspace}.ts`;`@zcode/ui` 的 `SSHDialog` / `RemoteConnectionDialog` 导出;工作区菜单与侧栏「+」里的「远程连接」、WSL UNC 路径改走 WSL 连接的提示、`AppProps` 的 `onConnectRemote / onSelectRemoteProject / onCancelRemoteProject / onOpenRemoteWorkspace / remoteConnectionInProgress / remoteConnectionLogs / remoteWorkspaceSessions / allowRemoteWorkspace` 透传、`useRemoteWorkspaceHistory` 的 `handleConnectRemote / handleSelectRemoteProject / handleOpenRemoteWorkspaceFromHistory`;i18n 里无引用的 `remote.* / remoteConnection.* / ssh.* / workspace.wslUncPrompt.*`。**保留**:main 的远程会话(`desktopRemoteSessions`、`desktopMainIpcRemote`)、host 的窗口连接注册表(`windowRemoteConnectionRegistry`)与 `remoteWorkspaceServiceCollection`、`packages/server/src/remote/**`、rpc remote、已保存远程标签页的恢复 / 重连 / 日志(`useRemoteWorkspaceHistory` 其余部分),因为 Host attachment、Web 远控与 Leo Link 共用这层;不再有新入口,只服务已有数据。
- 闲时任务的**界面**:`packages/ui/src/settings/{OffPeakEditView,OffPeakEditActionsMenu,OffPeakHistoryTab,OffPeakTaskList,OffPeakTemplateIcon}.tsx`、`settings/offPeakUiPresentation.ts`、`ui/src/hooks/{useOffPeakEligibility,useOffPeakTaskNotifications}.ts`、`ui/src/store/offPeakTaskStore.ts`、`ui/src/lib/offPeakTelemetry.ts`、`ui/src/ToolCallBlocks/renderers/offpeak-create.tsx`;自动化页只剩「定时」一个 tab(`AutomationsNavigationTab` 去掉 `idle`),模板目录去掉 off-peak 场景,会话轮尾的闲时卡片、首页推荐的 `NAVIGATE:AUTOMATIONS:OFFPEAK` 动作删除;i18n 无引用的 `offPeak.*`。**保留**:`offPeakTaskService` / scheduler 派发 / tasks 库的闲时表与迁移 / CLI 的 OffPeak 工具与协议 / 任务列表的「闲时」系统分组与月亮标记(用户数据与 CLI 协议共用,不迁移不删)。
- Z.ai 官方套餐(Coding Plan / Start Plan / Team Plan 企业套餐)整体删除,上游对这些文件的改动一律丢弃:
  - 界面:`packages/ui/src/settings/model-provider-section/{codingPlanEmbeddedWebview,codingPlanPurchaseAuth,codingPlanEnterpriseTiers,codingPlanPricingCards,codingPlanProductPresentation,codingPlanStatusPanelViewState,enterpriseCodingPlanProducts,providerFamilyConnectionVisibility,quotaModelDisplayName,useCodingPlanEntitlements,useCodingPlanProducts,useEnterpriseCodingPlanProducts,useStartPlanPreview,oauthActions}.ts`、`{BigModelRegistrationHint,CodingPlanStatusActions,CodingPlanStatusMeta,ProviderFamilyModeHeader,StartPlanBalanceCard,StartPlanCard,StartPlanQuotaStatusCard}.tsx`;`ui/src/settings/{CodingPlanEntryButton,CodingPlanUpgradeDialogProvider}.tsx`、`settings/codingPlanUpgradeLoginRecovery.ts`、`settings/usage-stats/{CodingPlanUsagePanel,CodingPlanUsageBarChart,CodingPlanUsageLineChart}.tsx`、`codingPlanUsageChartSeries.ts`;`ui/src/CodingPlanUsageRemainingPanel.tsx`、`ui/src/components/coding-plan-quota-reset/**`;`ui/src/chat-input-toolbar/{ChatCodingPlanMcpUsageMeter,CodingPlanContextUsage,CodingPlanUsageHeaderAction,CodingPlanUsageNotice,StartPlanContextBalance,contextQuotaResetOpportunityReminder}.tsx`、`{codingPlanQuotaResetAutoPlay,codingPlanResetOpportunityBadge,contextQuotaMeterGrid,contextPanelAction}.ts`;`ui/src/v4/{ConversationQuotaBanner.tsx,useV4SessionQuotaBanner,sessionQuotaBannerState,sessionQuotaBannerDismissalStore,startPlanQuotaBuckets,startPlanQuotaReminderStore,mcpUnavailableBannerNotice}.ts`;`ui/src/hooks/{useCodingPlanEntryPlanList,useCodingPlanQuotaResetUi,usePlanIdentitySnapshot,useStartPlanRecommendation,useUsageEntitlement,useStableAccountAccess}.ts`;`ui/src/lib/{codingPlanFunnelTelemetry,codingPlanOwnedEntryPlans,codingPlanProvider,codingPlanQuotaPresentation,codingPlanQuotaResetConfetti,codingPlanQuotaResetCoordinator,codingPlanQuotaResetUi,codingPlanUsageSources,sidebarCodingPlanUpgrade,sidebarUsageCodingPlanProviderPreference,startPlanEntitlementOptions,startPlanRecommendation,usageEntitlementCache,usageEntitlementRefreshPolicy,accountProviderAccess,modelProviderFamilyConnectionSelection,selectionSideInheritedModel,teamPlanDisplayName}.ts`;`ui/src/store/codingPlanQuotaResetState.ts`;`ui/src/root/{accountConnectionLossSuggestion,accountConnectionRefreshObserver,oauthProviderFamilySelectionRefresh,oauthTeamPricing,useAccountConnectionLossNotification}.ts`;`ui/src/WorkspaceSidebarFooterPlanBadgeHelpers.ts`;素材 `assets/provider-icons/model-provider-start-plan.png`。
  - 接线:`Root.tsx` 不再包 `<CodingPlanUpgradeDialogProvider>`;侧栏页脚 / 设置页去掉 `onUpgradeClick`;输入框工具条只剩上下文用量(`ChatContextUsage` 去掉 `codingPlanUsageRemaining` / `startPlanBalance`);`SessionPane` 去掉额度横幅、升级入口、Start Plan 推荐与 `readPlanIdentitySnapshot`(连带 `ConversationComposer` / `ChatErrorBanner` 的 `onOpenModelUpgrade` / `onOpenUpgrade`、遥测 `plan_status` / `plan_product_id`);自动化 / 子智能体保存不再弹 Start Plan 推荐;模型供应商设置页只剩「自定义供应商」(导航项类型只有 `custom`,`Detail` / `StatusCards` / `useModelProviderNavigation` / `constants` 精简);使用统计只剩「应用用量」(`UsageStatsSection` 无 tab 参数,`settingsNavigation` 去掉 `setPendingSettingsUsageCodingPlanIntent` / `shouldFallbackSettingsUsageTabToApp` / `consumePendingSettingsUsageTab`);`buildRegistryModelSelectGroups` 去掉套餐分组与徽标参数;`formatModelChangeLabel` 不再拼套餐名;`useRootOAuthEffects` 去掉登录后按套餐重选连接方式与账号连接丢失提示;插件商店去掉「编程套餐」徽标;test-id `TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON` 改名 `TID_SIDEBAR_USAGE_BUTTON`,删掉 Start Plan / 连接方式相关 test-id;i18n 删掉无引用的 `settings.modelProvider.{codingPlan,startPlan,planCard,connectionMode}.*`、`codingPlan.quotaReset.*`、`chat.quota.*`、`chat.planUsage.*`、`sidebar.usage.plan.*`(`openStats` 改名 `sidebar.usage.openStats`)、`settings.usage.{codingPlan*,entitlement*,billingBanner.*}`、`startPlan.recommendation.*`、`usage.error.{chatPlan,entitlement}.*`、`purchase.entry.*` 等约 600 条。
  - 服务 / 协议:`packages/services/src/coding-plan-subscription/**`(订阅、购买、企业订单接口)换成本地 `services/src/feature-config/`(`IFeatureConfigService`,channel `feature-config`,只裁决闲时任务与动态工作流开关;accessor 字段 `featureConfigService`);`services/src/usage-stats/providers/**`(套餐额度、用量监控、额度重置)删除,`IUsageStatsService` 只剩 `getAppUsageSnapshot`;`shared` 删 `coding-plan-subscription.ts`、`coding-plan-reset.ts`、`usage-quota.ts`、`plan-identity.ts` 与 `usage-stats.ts` 里的套餐 / Entitlement 类型,`ForceUpdateConfig` 并入 `forceUpdate.ts`;`CodingPlanWebviewChannels`、`DesktopCommandIds.ClearCodingPlanWebviewStorage`、`isTrustedCodingPlanWebviewOrigin`、`buildBigModelCodingPlan{Personal,Team}ManageUrl`、family spec 的 `teamCodingPlanManageUrl` 删除;desktop 删 `preload/codingPlanWebview.ts`(tsup 入口、vite `VITE_CODING_PLAN_WEBVIEW_ORIGIN`)、`desktopWindowChrome` / `desktopMainIpcRemote` 里的官网购买页 / PayPal webview 路由、`clearCodingPlanWebviewStorage`。
  - **保留**:`BUILTIN_MODEL_PROVIDER_IDS` 与账号 Provider 适配层(`model-provider/{accountProvider*,codingPlanProviderAvailability,zaiStartPlanBilling,bigmodelStartPlanZcodeJwt}.ts`、`bigmodel/{codingPlanEntitlement,teamPlanApiKey}.ts`、`legacy*Provider*`、CLI 侧 `coding-plan-api-key` / `official-coding-plan-gateway`):它们是官方账号的运行时解析与旧配置读取,和 CLI 协议(`ZCodeProviderAccountAccess`)共用,Leo 从不产生账号 Provider,只读不写;设置字段 `startPlanRecommendationDismissed` / `providerFamilyConnectionSelections` 保留可读(旧数据不报错);离线闲时任务(`offPeak*`)与官方 MCP 错误码映射照旧;聊天报错归因表里的官方错误码与 provider id 保留。账号凭据请求头构造从被删的订阅服务挪到 `model-provider/officialLoginAuthHeaders.ts`。

## v3.15.1 同步记录(2026-10-17,WP-11,分支 sync/zcode-3.15.1)

上游单个提交 aac47556,11,736 个文件变更(9.8k 新增,多为首次公开的测试与文档)。合并:126 个内容冲突、
132 个 modify/delete(131 个我们已删的文件保持删除,上游删除的 `services/device/deviceMid.ts` 接受删除)。

**三处静默失效(必须修,已修)**
1. 自动更新:3.15.1 改成 `enabled: ZCODE_PRODUCT_FLAVOR === "production" && ZCODE_AUTO_UPDATE_ENABLED`,后者默认关。
   `leo:bundle:mac` 显式注入 `ZCODE_AUTO_UPDATE=1`,并把 `ZCODE_ARMS_RUM_ENDPOINT` / `ZCODE_TELEMETRY_REPORT_ENDPOINT` 置空。
2. 官方地址:`zcodeEndpoint.ts` 的 `TEST_*`、Web 远控中继默认值;`.env.production` / `.env.development` 的官方地址与
   OAuth client id 改成死端口 / 空(vite / tsup 会编进产物,`desktop/test/viteRendererConfig.test.ts` 断言渲染层是死端口)。
3. 网络兜底:3.15.1 的 `main/observeBeforeRequest.ts` 统一分发 `onBeforeRequest`,资源管理器抓包开 / 关会重装、清除监听。
   `observeBeforeRequest.ts` 增加「拦截者」(`blockBeforeRequest`),`leoSessionGuard.ts` 登记为拦截者;插件 UI 沙箱分区
   `persist:plugin-sandbox-v1-*` 自己的监听里(`pluginSandbox/session.ts`)先判官方域名并取消;`leoNetworkGuard.ts` 补 `codegeex\.cn`。
   测试:`desktop/test/unit/leoSessionGuard.test.ts`。

**新增 / 变化的补丁(同步时复查,改动处标 `[leo]`)**
| 文件 | 内容 |
|---|---|
| `apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts` | 3.15.1 把官方网关改写搬到 endpoint-routing 端口;`createStaticProviderEndpointRoutingPort` 恒 `routed:false`,官方端点映射表删除 |
| `apps/zcode-cli/packages/core/src/runtime/methods/mcp.ts` | 新增的 `refreshMcpToolsIfChanged`(list_changed 热刷新)同样套 `applyLeoLeanToolAllowlist` |
| `apps/zcode-cli/packages/core/src/permission/service.ts` | `[leo]` alwaysAsk 放行同时适用 yolo 与 guarded |
| `packages/ui/src/leo/leoDefaultTaskMode.ts` + `v4/composer/{newTaskDraft,draftWorkspaceDefaults,useDraftConfigControl,V4ComposerModeControls}` | 新任务默认权限档 guarded(用户拍板),yolo 仍可选 |
| `apps/zcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts` | 出网口 `request` 在发请求前失败;官方主机指向死端口 |
| `apps/zcode-cli/packages/adapters/src/http/{index,raw-response}.ts` | 公网 DNS transport 用我们的 raw-response:返回 ResponseLike,接受 100–999 状态码(同上游),并做 gzip/deflate/br 解压(上游不解压) |
| `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts` | 官方图标 CDN 基址指向死端口(该文件三方合并 clean,最容易漏) |
| `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` | 作者 LeoBot、不带官网;删 image-search 与 documents/pdf/presentations/spreadsheets;新增 superpowers(默认不启用) |
| `packages/desktop/scripts/prepare-agent-node-bundle.mjs` | 随包:visualize、browser-use、ios-simulator、skill-creator、plugin-creator、zcode-guide、superpowers、node-repl-host + bundled-skills |
| `packages/shared/src/plugin-marketplaces.ts` | 默认启用名单去掉 image-search 与文档四件套 |
| 随包插件 `.zcode-plugin/plugin.json` 与技能文档 | ZCode→LeoBot、作者 Z.ai→LeoBot、用户级 `~/.zcode`→`~/.leophoneagent` |
| `config/provider/zcode-builtin(.test).json` | revision 32;删 highspeed 两个隐藏 provider;官方主机统一换成 RFC 2606 保留域(`api.zai.invalid`、`open.bigmodel.invalid`…,URL 与站点规则正则同步);opencode-go-chat 默认启用成员排前 |
| `packages/services/src/feature-config/featureConfigService.ts` | 接上 3.15.1 的动态工作流用户选择(`resolveDynamicWorkflowUserMode`) |
| `packages/services/src/node.ts` | 不注册 output-style(读写 `~/.claude`)、highspeed、marketing-touch、cloud-content;机器人频道回复 / 话题资源直接报不可用 |
| `packages/desktop/src/main/index.ts` | Web 远控 manager 的 feature gate 恒关,IPC 不注册 |
| `packages/desktop/src/main/desktopWindowChrome.ts` | 只有内置浏览器与插件 UI 沙箱两类 webview guest(官网购买页 / PayPal / 奖励页不接线) |
| `packages/desktop/src/main/desktopMainIpcRemote.ts` | 只剩通用 IPC;`file:` 链接交给默认应用打开(吸收 3.15.1) |
| `packages/desktop/src/main/desktopArchitectureGuard.ts` | 架构不匹配的下载页 → leocodebox-updates 发布页 |
| `packages/shared/src/{bots.ts,zcode-protocol/index.ts,zcode-protocol-v4/*}` | 机器人只保留协议 schema(CLI bootstrap 在用);`botDeliveryTarget` 维持 1.9.0 删除 |
| `packages/services/package.json` | `@agentclientprotocol/sdk` ^1.9.0(WP-21 用),去掉 lark |
| `packages/services/src/gen-ui/contract.test.ts` | 补上游缺的契约测试(architecture:check 的 missing-module-artifact) |
| `scripts/native-search-tools-config.mjs` + `apps/zcode-cli/dependencies/native-search/` | 只留 darwin-arm64 归档(22M→2.7M),启用平台只剩 darwin-arm64 |
| `packages/desktop/electron-builder.config.js` | computer-use 插件不随包,未 stage 时跳过 CUA koffi 校验(否则 afterPack 失败) |
| `scripts/leo-redline-check.mjs` | 红线闸:`leo:bundle:mac` 打包前扫源码、打包后扫产物;app.asar 按索引逐条目扫,包内第三方 node_modules(pi-ai、tokenlens 的供应商目录)与磁盘产物同一排除规则 |
| `packages/ui/src/styles.css`(WP-30) | 工作流运动词汇 `--wf-t-*` / `--wf-ease` / `--wf-beat` 换成 LeoBot Design token(`--leo-dur-*` / `--leo-ease-settle` / `--leo-beat`,源 `design/tokens.json`);同步上游时新出现的 `--wf-t-*` 按同一映射替换;顶部 `@import "./leo/skin/leo-tokens.css"` 保留 |

**删除面(随合并)**:`packages/server`、`packages/web`、`packages/android`、`packages/web-share`、`packages/share-ui`、
`packages/stream-animate`;SSH/WSL/Docker/server 远程工作区(desktop host / main / preload / UI 恢复与重连 / 远端资产脚本);
加速卡 highspeed、营销触达、云内容、奖励、全局通知、手动领取套餐、Web 远控移动壳 / 任务索引、机器人群聊 UI 等上游新增模块;
cdn-preload.sh。上游首次公开的测试里,只能经已删模块运行的测试文件一并删除。完整路径见删除清单(672 条,覆盖 2221 个上游文件)。

**已知未跟上的上游测试**:上游 3.15.1 首次公开约 6k 个测试文件,我们的分支此前从未跑过它们。与 WP-11 改动相关的已改写或
按 `[leo]` 理由 skip;其余失败来自更早的 Leo 补丁(数据根 `~/.leophoneagent`、产品名 / 深链 scheme、官方账号与遥测切断、
1.9.0 删除的分享 / 额度 / 模型选择器改版等),逐个对齐留待后续。`node scripts/licenses.mjs notices` 因 Leo 自有依赖
(pi 系、aws-sdk 等)缺少人工核对的声明而失败,THIRD-PARTY-NOTICES.md 暂取上游版本。

**验证(WP-11 收尾)**:install / typecheck / lint(0 error)/ 全量 architecture:check / leo:test:agent 78/78 绿;红线源码 0 命中,
反向验证(源码与 asar 内一方代码植入官方地址均 exit 1);无签名 `bundle --os mac --arch arm64` 成功,产物红线 0 命中,
主进程产物里 `ZCODE_AUTO_UPDATE_ENABLED` 编译为 true。隔离 HOME / ZCODE_HOME / userData 的 dev 冒烟(`ZCODE_PRODUCT_IDENTITY=leo`,
窗口标题 LeoBot):首屏、设置 → 模型设置(本机 mock 供应商拉模型)、发消息收到回复、扩展 → MCP 服务器页均正常;
新任务默认「自主模式」(guarded)。注意:dev 冒烟只设 `ZCODE_HOME` 不够,CLI 层多处直接用 `homedir()/.leophoneagent`,必须同时改 `HOME`。

**主控决定(2026-10-17)**:红线按域名形态匹配(不扫裸词 bigmodel / zhipu);文档类插件不随包;superpowers 随包且默认启用
(`official-plugin-definitions.ts` 的 `defaultEnabled` 与 `shared/plugin-marketplaces.ts` 名单同步);发给模型的提示词里
ZCode 一律写 LeoBot(`core/src/context/sections/{identity,desktop}.ts`、子智能体 / 工作流 / system-reminder / 工具描述、
`/init` 内置命令,测试同步改写);computer-use(上游 zcode-cua 占位,Mac 的电脑操作由 Peekaboo 提供)与
restore-legacy-sessions 进 `INTERNAL_OFFICIAL_PLUGIN_IDS`,设置页与插件市场都不列出。

**并入 Mac 线(merge upgrade/full-2026-10 @ 2099c4e8)**:WP-01 的删除优先(forceUpdateGuard / forceUpdatePrompt、
`packages/zcode-server-cli`、`packages/formal-proof`、`harness/remote`、零引用 ai-elements 组件与无引用 i18n);
例外:`ai-elements/plan.tsx` 被 3.15.1 的 TodoPanel 使用,保留。`main/index.ts` 用 3.15.1 的托盘 / 请求安全诊断接线,
再挂 Leo 的菜单栏 + ⌥Space 快速派发、iMCP、电脑操作与语音 IPC;`electron-builder.config.js` 同时保留蓝牙与麦克风用途说明、
Peekaboo(`leo/bin`)/ leo-speech / 菜单栏模板图标三类 extraResources;`leo:bundle:mac` 顺序为
发布说明校验 → 源码红线 → 取 Peekaboo → 编 leo-speech → 打包 → 产物红线。删除清单重新生成(711 条 / 2346 个上游文件),
已包含 WP-01 的删除,下次同步上游时自动套用。

## v3.16.1 定点摘取(2026-10-20,分支 wt/deps)

上游 `0a1fc56d`(zai-org/ZCode main,10-19,「chore: sync ZCode source」,v3.16.1)。**没有整体 subtree 合并**:
上游加回了远程 server / relay v2 / project-storage 迁移,和我们的删除面冲突。subtree 同步点仍是 `aac47556`,
下次整体 `subtree merge` 时下面这些文件会与上游一致或只差我们的 `[leo]` 行,按常规三方合并即可。

**已摘(每项单独提交,提交说明写了上游出处)**
| 内容 | 文件(均在 `apps/zcode-cli/packages/` 下) |
|---|---|
| fs 文本编码:大文件 4KB 头部样本切在 UTF-8 多字节字符中间时误判 gb2312 / 拒读;短读未读满样本 | `adapters/src/fs/{text-metadata,text-range-reader}.ts`(原样)、`adapters/tests/fs-text-encoding.test.ts` |
| 空 completion 收尾:零输出且明确超窗时直接转 `ModelContextExceeded` 走压缩/失败链,不再空响应重试;拒绝 / 内容过滤不重试;失败请求已报告用量随失败结算 | `adapters/src/model/{runner-diagnostics,runner-generate,runner-stream,errors}.ts`(原样)、`contracts/src/model/index.ts`(只 `usage` 字段)、`contracts/src/events/session.events.ts`、`core/src/subagent/runner.ts`(只用量 hunk)、`adapters/tests/runner-empty-completion-finish.test.ts`、`runner.test.ts` 一处 |
| 附件冷恢复一致性:首发 / 队列 / resume 共用 `buildUserMessageEntries`;路径引用说明存 `metadata.pathReferenceText` 恢复时原样复用 | `core/src/agent/{message-history,session-history-hydrator,file-part-hydration}.ts`(只附件部分)、`core/src/runtime/helpers/{conversation,attachment-path-reference}.ts`、`contracts` `AttachmentStorageMetadata.pathReferenceText`、`adapters/tests/attachment-resume-wire.test.ts` |
| TaskStop 查找失败提示不再被模型误读为「已停止」 | `core/src/tool/handlers/task-stop.ts`(只文案) |

**没摘及原因**
- **tool-search(MCP 工具延迟加载 / DeferredToolCall)**:不是 bug 修复而是一整套功能,CLI 内 57 个源文件
  (message-history / hydrator / turn-loop / call-runner / subagent / server-operations 等核心路径,另有 30 个测试),
  并且要动 `packages/shared`(`AppToolSearchMode`、runtime-preferences 协议字段)、`packages/services`、`packages/ui` 设置页
  才能打开;上游默认 `off`,自己也标注「实验性,provider 不完整支持时可能导致缓存失效、Token 增加」。试合并有 5 处冲突
  (subagent.ts 一大块、server-operations 夹带我们已删的 `ZCodeAutomationBotDeliveryTarget`),只搬 CLI 部分会成为打不开的死代码。
  建议单独立项:CLI + shared 协议 + 设置页一起做,先保持默认 off。
- Highspeed 加速卡、闲时任务(off-peak)、动态工作流提醒、模型 Registry 缺失时的创建期退回(和 Highspeed 绑在一起)、
  MCP Apps 等待连接、附加目录 skills/commands 根、远程 server / relay v2、session-store 迁移重写(`schema.baseline.sql`、
  `migration-runner.ts`、软删除 `deleted` 取代 `archived`)、office-runtime 与文档类插件:属官方功能或我们已删的模块,一律不摘。
- 其余大量 diff 是 oxfmt 重排版,无行为变化。

**复查**:摘完后对本分支相对改动 grep `z.ai / bigmodel / chatglm / zhipu / zcode.ai / codegeex / .zcode` 0 新增;
`node scripts/leo-redline-check.mjs` 0 命中。

## Electron 44 / claude-agent-sdk 0.3.304 补丁(2026-10-20,wt/deps,同步上游时复查,改动处标 `[leo]`)
| 文件 | 内容 |
|---|---|
| `packages/desktop/package.json`、`pnpm-lock.yaml` | Electron 41.10.7 → 44.5.1;node-abi 4.28.0 → 4.38.0(否则 @electron/rebuild 认不出 44 的 ABI) |
| `packages/desktop/src/main/pluginSandbox/host.ts` | 44 删了 `clipboard.writeImage`:改 `clipboard.write([new ClipboardItem({"image/png": Blob})])` |
| `packages/desktop/scripts/gen-ui-fixture/presentation-checks.ts` | 夹具里的 readImage / readText / writeText 改异步剪贴板 |
| `packages/desktop/src/main/desktopMainIpcPlatform.ts` | 43 起打开框默认「下载」且不记上次目录:选目录 / 选文件记住上次所在目录 |
| `packages/desktop/scripts/dev.mjs` | 42 起不再 postinstall 下载二进制:`require("electron")` 按需下载并取路径 |
| 根 `package.json` `pnpm.overrides` | `@agentclientprotocol/claude-agent-acp>@anthropic-ai/claude-agent-sdk: 0.3.304`;acp 升到 0.94+ 时去掉 |

## P1 首轮提速 / 空闲内存补丁(up-p1-mac,同步上游时复查,改动处标 `[leo]`)
| 文件 | 内容 |
|---|---|
| `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` | superpowers 去掉 `defaultEnabled`(默认关,仍随包可开);`packages/shared/src/plugin-marketplaces.ts` 名单同步删掉。无迁移:随包 seed 不落盘 `enabledPlugins`,只有手动切换才写 |
| `packages/shared/src/zcode-protocol/index.ts` | `zcodeProcessResourceSampleSchema` 加可选 `residentSessionCount` |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/resource-sampler.ts` | 60s 资源样本附带进程内常驻 session 数 |
| `packages/services/src/zcode-agent/zcodeAgentService.ts` | 挂 `createLeoMainLaneIdleRecycler`(新文件 `leoMainLaneIdleRecycle.ts`):主泳道 20 分钟空闲回收,回收动作同 `disposeWorkspace` |
| `packages/services/package.json` | 导出 `./leo-main-lane-idle-recycle`(手机桥接登记默认工作区不回收) |
