# leocodebox 1.68.0 — 对话即首页：工作台外壳重做

这一版把 Mac 端从「9 项侧边导航 + 双侧栏 + 仪表盘首页」的工作台，换成一条
**对话优先**的极简外壳。冷启动直接落在会话上，新任务只有一个入口。

## 外壳结构

```
46px  标题栏     LEO · 本机名 │ 远程胶囊 · Leoapi · ⌘K · 外观 · 设置
      指挥条     820px 悬浮玻璃条:Agent ▾ + 输入 + @目标 + 权限模式 + ⏎
264px 会话列表   进行中 / 今天·已完成(本机与远程同列,meta 标机器名)
      会话详情   复用现有 ChatInterface(审批、斜杠命令、@文件、图片、语音、token 预算)
30px  状态栏     本机服务 · 体检 · 本地日志 · 版本号
```

- **删除**:`DesktopAppRail`(9 项导航)、仪表盘的首页地位、Fleet 独立 Tab、
  快速任务独立 Tab、常驻项目树侧栏。
- **迁移**:仪表盘数字 → Leoapi 面板与设置·关于;Fleet → 标题栏远程胶囊;
  快速任务 → ⌘K;项目树 → ⌘K 唤起的项目抽屉(仍是同一个 `Sidebar`,
  新建/重命名/删除/归档/搜索一个没少)。
- 停在 `dashboard` / `fleet` / `missions` 的旧安装会被一次性迁移到对话页。

## 指挥条:全局唯一的新任务入口

- Agent 下拉的版本号、更新提示与登录态来自设置页同一条 `/api/leocodebox/cli/status`,
  不另起数据源。
- 选 Agent 与切权限模式走 `PreferencesContext`,与设置页共用一份持久化状态。
- 回车 = 建会话 + 把这句话作为第一条指令发出去。发送复用 ⌘K handoff 已跑通的
  `leocodebox:handoff-draft` 链路(新增 `send` 字段);目标忙碌时由 `handleSubmit`
  自己入队 —— **不吞回车**。
- 五档权限:默认审批 / 计划模式 / 接受编辑 / 全自动 / 跳过审批。

## 远程:接管是真的接管

`@目标` 可以切到任意一台在线的远程 Mac,标题栏胶囊里可以直接接管它上面的会话。
新增三条中继薄代理(`server/modules/leophone/fleet.routes.ts`):

```
POST /api/leophone/fleet/sessions                                    远程建会话
GET  /api/leophone/fleet/machines/:m/sessions/:id/events?after=N     SSE:全量回放 → 实时跟随
POST /api/leophone/fleet/machines/:m/sessions/:id/{send,stop}        多回合驾驶 / 叫停
```

前端 `RemoteSessionPanel` 按 seq 续传:断线后带着已收到的最大 seq 重连,回放缺口
再继续跟随,不丢不重。审批复用既有的 `/api/leophone/approvals/respond`。
leocodebox **不复制**远程会话状态——会话的家始终在那台机器上。

## 菜单栏与状态栏:AI 额度

**两处都有**:macOS 菜单栏(托盘)和应用窗口底部的状态栏。

菜单栏图标旁显示柱状计量 + 最紧张的那个百分比(`▆▂ 73%`),左键点开是一个
无边框面板窗口 —— 不是原生菜单。原生 Menu 只能排灰色文本,画不出计量条、
重置倒计时和刷新按钮,而菜单栏工具的价值恰恰在于"一眼看到还剩多少"。
面板是同源的独立工具页 `public/leocodebox-quota.html`(与 Leoapi 切换页同一套
做法),复用 preload 注入的本地 token,不另建鉴权通道。右键仍是原生菜单:
额度速览 + 本地服务 + 退出。

窗口底部的状态栏右侧同样有一个额度计,点开是应用内的额度浮窗。

思路借自(⏲ 图标 + 计量条 + 百分比),点开是本机 AI 用量总览。
思路借自 [CodexBar](https://github.com/steipete/CodexBar):**不登录任何一家服务**,
只读各家 CLI 已经落在本机的状态。界面上严格区分两类数字:

| 来源 | 内容 | 标注 |
|---|---|---|
| `~/.codex/sessions/*.jsonl` 的 `rate_limits` 帧 | 服务端下发的真实额度窗口:已用百分比、窗口长度、重置时间、套餐、余额 | 权威 |
| `~/.claude/projects/*.jsonl` 的逐条 `usage` | 近 5 小时的 token 与调用次数 | 「本机统计」 |
| Leoapi 网关 meter | 今日 tokens / 调用次数 / 费用 | — |
| `/api/leocodebox/cli/status` | 其余 Agent 的安装、版本与登录态 | — |

读不到就显示"读不到",**不填 0、不编百分比** —— 把估算值摆成配额是最容易骗到
自己的做法。采集在服务端做,60 秒缓存,只读日志尾部 512KB(会话日志能到几十 MB)。

**尚未接入的 provider 照样列在清单里**,状态写明"未接入"以及缺什么凭据 ——
授权是陆续补的,清单要能回答"还差谁",而不是让缺的那几家凭空消失。
本机实测 `~/.cursor`、`~/.grok`、`~/.gemini`、`~/.local/share/opencode` 都没有落
额度数据;CodexBar 拿这几家靠浏览器 cookie、OAuth 设备流和各家后台 API,
接进来需要一层凭据采集,这一版留出了位置但没有实现。

## 设置

栏目一个没减,只重新归组:外观从「系统」移入「工作区」(它调的是工作环境),
插件从「智能体」移入「系统」(它扩的是工作台本身)。弹窗改 1000×660。

## 视觉

`tokens.css` 换成设计稿的两套色板,仍走现有 HSL semantic token 体系:

| | 深色 | 浅色 |
|---|---|---|
| 背景 | `#121514` | `#f6f5f1` |
| 前景 | `#ecf1ef` | `#1b201e` |
| 主色 | `#56f0b8` | `#0f766e` |
| 面板 / 日志 | `#171b1a` / `#0d100f` | `#fbfaf7` / `#efede6` |

新增 7 个工作台专属表面 token(`--wb-chip/-line`、`--wb-bar/-line`、`--wb-log`、
`--wb-faint`、`--wb-accent2`),这些表面在原体系里没有对应物。动效全部响应
`prefers-reduced-motion`。

设计稿的两个底色实机铺开后偏色(浅色 `#f6f5f1` 发黄、深色 `#121514` 发绿),
色相饱和度各收了一档到近中性;同时移除了外壳上那层 webp 噪点纹理(浅色
cold-metal / 深色 graphite,3.5%–5% 不透明度)—— 它正是"底色不纯"的来源。

## 修复:外壳浮层被打回文档流

`chat.css` 里长期存在一条 `.leocodebox-app-shell > * { position: relative; z-index: 1 }`,
用来把内容抬到背景纹理层之上,代价是**改写了每个直接子元素的定位**。任何挂在外壳
下的 `fixed`/`absolute` 浮层都会被打回文档流:

- Leoapi 面板出现在状态栏下方,而不是右侧滑出;
- 「打开完整网关设置」的模态同样掉进文档流;
- 指挥条的 Agent 下拉、标题栏的远程弹层被压平到 z-1,被 DOM 里更靠后的主区盖住。

改为纹理层留在 `z-index: 0`,由外壳的四个在流子元素各自声明层级
(标题栏 40 > 指挥条 30 > 状态栏 20 > 主区 10),浮层自己用 `fixed` / portal。
状态栏原本靠那条规则白拿 `relative`(体检气泡依赖它定位),现已显式声明。
浮层层级梯子对齐仓库既有值:项目抽屉 54/55、Leoapi 56/57,均在本地工具模态 70、
设置 9999、Dialog 10000 之下。`tokens.test.ts` 新增一条断言把这条规则钉死。

## 验证

- 前后端 typecheck 全绿;改动文件 eslint `--max-warnings=0` 通过。
- 客户端单测 24 项全过(含新增的"退役 Tab 迁移到对话页"与"外壳不得 blanket 定位子元素")。
- 生产构建 `npm run build` 通过(client + server)。
- 桌面端 `npm run desktop:dev` 实跑:工作台、指挥条、会话列表、远程胶囊、
  设置、Leoapi 面板均正常渲染。

## 升级路径

热更新走 `leoyb1010/leocodebox-updates`。发布需要 Developer ID Application 证书与
钥匙串里的公证 profile(见 `docs/SIGNING.md`),本机当前只有 Apple Development 证书,
因此 1.68.0 尚未打包发布。
