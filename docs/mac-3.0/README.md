# LeoPhoneAgent Mac 3.x

Mac 端从 3.0 起换成 **ZCode 内核**(zai-org/ZCode,Apache-2.0),工程在 `src/mac/leophone/`。
`src/mac/leocodebox/`(2.2.13,pi 内核 + 自研壳)保留作回退与历史会话查阅,不再开发。

## 它是什么
上游 ZCode 的全部能力原样可用:会话工作台与分组任务、工具时间线、Git 面板、
工作区文件树与搜索、终端、内嵌浏览器与 Browser Use、插件商店、MCP、技能、Hooks、
斜杠命令、自动化与闲时任务、记忆、会话分享与导入、SSH / WSL / Docker 远程工作区、
权限四档(plan / build / ask / yolo)。

我们自己的部分只有四处,都集中在少数文件里,方便跟上游同步:

| 我们的改动 | 文件 |
|---|---|
| 产品身份(LeoPhoneAgent / com.leoyuan.leocodebox) | `packages/desktop/scripts/desktop-product-identity.mjs` |
| 遥测关闭 | `packages/shared/src/env.ts` |
| 更新源指向 leocodebox-updates | `packages/desktop/src/main/leoUpdateFeed.ts`、`autoUpdater.ts` |
| 本次更新弹卡 + 发版闸门 | `packages/ui/src/leo/`、`packages/ui/src/Root.tsx`、`scripts/leo-verify-release-notes.mjs` |
| 藏宝阁 + Telegram | `packages/desktop/src/host/leo/`、`packages/desktop/leo/treasury-mcp.mjs` |
| 品牌资源 | `packages/desktop/build/icon*`、`packages/ui/src/assets/leo-logo.svg`、两个 locale |

## Leo 层
- **藏宝阁**:`~/.leoagent/treasury.sqlite`(node:sqlite,不引原生依赖)。四个工具
  `treasury_search / treasury_get / treasury_save / treasury_update`,首启自动登记进
  `~/.agents/mcp.json`,任何会话都能用。写操作要求 `user_confirmed: true`。
- **Telegram**:配置在 `~/.leoagent/channels.json`(0600)。配对后说话即开会话,
  权限请求以内联按钮推送 —— 用的是 ZCode 自己的权限系统(`respondPermission`),
  不另搞一套策略。
- **本机接口**:`127.0.0.1:38473`,Bearer 来自 `~/.leoagent/key`,只给藏宝阁 MCP 与设置页用。

## 常用命令(在 `src/mac/leophone/` 下,Node 24 + pnpm 10.33)
```bash
corepack pnpm@10.33.2 bootstrap                       # 首次
ZCODE_DATA_BASE_DIR="$HOME/.zcode-dev-home" corepack pnpm@10.33.2 dev:desktop:test
corepack pnpm@10.33.2 typecheck && corepack pnpm@10.33.2 lint && corepack pnpm@10.33.2 architecture:check -- --changed
ZCODE_ENABLE_MAC_SIGN=1 APPLE_SIGNING_IDENTITY="Developer ID Application: leo yuan (48H5Y3LNUK)" \
  corepack pnpm@10.33.2 leo:bundle:mac                # 闸门 + 构建 + 签名
bash scripts/leo-notarize-mac.sh packages/desktop/dist/LeoPhoneAgent-<版本>-mac-arm64.dmg
corepack pnpm@10.33.2 leo:finalize:mac                # manifest + latest-mac.yml
```
仓库在 iCloud 上,**不要在 iCloud 目录里跑 pnpm**:用 `git worktree add /tmp/leophone-mac` 到本地盘构建。

## 发版铁律
每次发版都必须在 `packages/ui/src/leo/leoReleaseNotes.ts` 最前面加一条,版本号等于
根 `package.json` 的 version。`leo:bundle:mac` 链首就是闸门,漏写打不出包(已反向验证会红)。

## 这一版没有的
手机远程控制(中继)这一版暂停 —— 2.x 的中继与手机审批没有搬过来,下一轮对齐。
2.2.x 的会话不迁移,要翻旧记录打开保留的 leocodebox 2.2。
