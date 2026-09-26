# LeoPhoneAgent Mac 1.x(ZCode 内核)

Mac 端换成 **ZCode 内核**(zai-org/ZCode,Apache-2.0)并改成我们自己的独立产品,工程在
`src/mac/leophone/`。`src/mac/leocodebox/`(2.2.x,pi 内核 + 自研壳)只作回退与历史会话查阅,不再开发。

## 它是什么
ZCode 的本地能力都在:会话工作台与分组任务、工具时间线、Git 面板、文件树与搜索、终端、
内嵌浏览器与 Browser Use、随包插件、MCP、技能、Hooks、斜杠命令、自动化、动态工作流、记忆、
权限四档(plan / build / ask / yolo)。模型两种接法:订阅账号登录(OAuth),或 API Key 添加供应商。

依赖官方服务器的部分已关闭:官方账号与 Coding Plan、会话分享与导入、闲时任务、官方插件市场远端分片、
SSH / Docker 远程工作区(远端运行时原本从官方 CDN 下载,后续改由我们自己的更新源提供)。

## 独立性红线
- 不连任何 `*.z.ai / bigmodel.cn / zhipuai.cn / zhipu.ai / chatglm.cn / zcode.ai`:源头已切断;
  main / host / scheduler / agent 进程另在 DNS 层兜底(`packages/shared/src/leoNetworkGuard.ts`),
  界面侧在默认 session 兜底(`packages/desktop/src/main/leoSessionGuard.ts`)。
- 不读官方客户端的 `~/.zcode`:应用与 agent 数据在 `~/.leophoneagent`,Leo 层在 `~/.leoagent`。
- 不接官方账号;更新只走 `leoyb1010/leocodebox-updates`;链接协议 `leophoneagent://`。
- 同步上游前后按 `UPSTREAM.md` 的补丁清单逐条复查。

## Leo 层(`packages/desktop/src/host/leo/`)
- **订阅账号(OAuth)**:pi 的 `ModelRuntime` 负责各家授权流程、token 存储与刷新,凭据只在
  `~/.leoagent/oauth/auth.json`(0600)。登录页 `http://127.0.0.1:38473/leo/oauth` 在系统浏览器打开;
  `/v1/models`、`/v1/chat/completions` 是给 agent 用的 OpenAI 兼容代理,登录后自动登记为
  「订阅账号(Claude / ChatGPT / Copilot)」供应商。上游失败按真实 HTTP 状态回给 agent
  (401 提示重新登录、429 / 5xx 退避重试、超窗返回 `context_length_exceeded` 触发压缩)。
- **藏宝阁**:`~/.leoagent/treasury.sqlite`(node:sqlite)。四个工具
  `treasury_search / treasury_get / treasury_save / treasury_update`,首启登记进 `~/.agents/mcp.json`。
  写操作要求 `user_confirmed: true`。
- **Telegram**:配置在 `~/.leoagent/channels.json`(0600)。配对后说话即开会话,权限请求以内联按钮推送,
  走 ZCode 自己的权限系统(`respondPermission`)。
- **本机接口**:只绑 `127.0.0.1:38473` 并校验 Host。`/api/leo/*` 与 `/v1/*` 要 Bearer(`~/.leoagent/key`);
  登录页接口要 `X-Leo-UI` 头、不开 CORS。多窗口时只有抢到端口的 Host 跑 Telegram、MCP 登记与订阅同步。

## 常用命令(在 `src/mac/leophone/` 下,Node 24 + pnpm 10.33)
```bash
corepack pnpm@10.33.2 bootstrap                       # 首次
xcrun notarytool store-credentials leocodebox --apple-id <Apple ID> --team-id 48H5Y3LNUK
                                                      # 每台 Mac 一次:公证凭据进钥匙串(要本人输 App 专用密码);
                                                      # 没有它公证那步报 No Keychain password item found
corepack pnpm@10.33.2 typecheck && corepack pnpm@10.33.2 lint && corepack pnpm@10.33.2 architecture:check -- --changed
ZCODE_ENABLE_MAC_SIGN=1 APPLE_SIGNING_IDENTITY="Developer ID Application: leo yuan (48H5Y3LNUK)" \
  pnpm leo:bundle:mac                # 闸门 + 构建 + 签名(脚本里固定打开签名;不要经 corepack 调,嵌套的 pnpm 会变成 11.x 直接报错)
bash scripts/leo-notarize-mac.sh packages/desktop/dist/LeoPhoneAgent-<版本>-mac-arm64.dmg
corepack pnpm@10.33.2 leo:finalize:mac                # manifest + latest-mac.yml
gh release create v<版本> -R leoyb1010/leocodebox-updates <dmg> <zip> \
  packages/desktop/dist/leophone-manifest-darwin-arm64.json packages/desktop/dist/latest-mac.yml
```
不要在 iCloud 目录里构建;worktree 放在 `~/leophone-mac`(也不能放 `/tmp`:electron-builder 拒绝系统路径下的 pnpm 符号链接)。

## 发版铁律
每次发版都必须在 `packages/ui/src/leo/leoReleaseNotes.ts` 最前面加一条,版本号等于根 `package.json` 的
version,内容写这一版真实改了什么。`leo:bundle:mac` 链首就是闸门,漏写打不出包(已反向验证会红)。

## 手机远程控制(Leo Link)
中继帧在进程内交给 `packages/desktop/src/host/leo/link/`(手机协议 v0.4)。对手机只开放 `/health`、`/v1/capabilities`、
`/v1/grok/token`、`/harness/full-auto`、`/harness/sessions` 及其 `events | send | approval | stop | archive`,其余一律 404。
跑完一轮后 30 分钟没动的任务报 `available`(手机首页「进行中」只放在跑的和刚跑完的);Mac 重启认回的任务保留日志里最后一条事件的时间。
`archive` 只把任务从手机列表里拿掉:不动 Mac 上的对话,日志留着(再接管时编号接得上);还在跑的回 409。

## 这一版没有的
2.2.x 的会话不迁移,翻旧记录用保留的 leocodebox 2.2。
