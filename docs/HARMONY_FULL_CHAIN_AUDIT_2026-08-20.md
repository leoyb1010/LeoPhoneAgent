# 鸿蒙端全链路排查与修复方案（2026-08-20，基于 0.3.0-alpha.3 源码走查）

用户反馈：录入 API Key 后没有下一步；点登录授权网页打不开；模型读到了却到不了「选择模型」；
不止聊天，定时任务、当身体等执行链路也不贯通。本文是**只读排查**的结论，未改任何代码。

一句话结论：**添加供应商的流程在「保存」处断头（该跳详情页选模型却直接退回列表）；
OAuth 登录网页打不开主要是登录域名在大陆直连不通 + Web 组件无错误提示 + 控制器复用缺陷；
定时任务和当身体两条执行链在冷启动时根本没加载供应商档案，必报「还没配供应商」，
且定时任务的结果和报错全部被丢弃，用户永远看不到。**

---

## 一、三个直接症状的根因

### 症状 A：录入 API Key 后「没有下一步」

| # | 根因 | 证据 |
|---|------|------|
| A1 | 保存成功后直接 `router.back()` 退回列表，**没有进入选模型环节**。代码里 `ProviderLaunch.id = row.id` 已经为跳详情页备好参数，却没有跳 —— 这是断头的直接证据 | `AddProviderPage.ets` L515-516 |
| A2 | 保存成功**没有任何提示**（无 toast、无落点高亮），用户感知就是「点了没反应」 | `save()` 全程只在失败时写 `message` |
| A3 | 新实例**不会自动设为当前供应商**：`upsert` 只在 `activeId` 为空时才激活（L224-226）。已有旧供应商时，新加的那个永远不生效，聊天/任务仍用旧的 | `ProviderStore.ets` L224-226 |
| A4 | 配置页是 Scroll 内普通布局，键盘弹起可能遮住底部「添加供应商」按钮，加剧「没有下一步」的感知 | `AddProviderPage.ets` L295-304 |

### 症状 B：点「登录授权」网页打不开

| # | 根因 | 证据 |
|---|------|------|
| B1 | **登录域名大陆直连不通**：`auth.openai.com`（OpenAI）、`claude.ai`（Anthropic）、xAI 的验证页都需要可翻墙网络。手机上没有代理时 ArkWeb 只能白屏。Mac 端开发时有本地代理（127.0.0.1:7897），手机没有 | `BrowserOAuth.ets` L191-197 的三个 authUrl |
| B2 | Web 组件**没挂任何错误回调**（无 `onErrorReceive` / `onHttpErrorReceive`），加载失败时界面停在白屏，`message` 停在「正在打开登录」，没有任何反馈 | `AddProviderPage.ets` L111-121 |
| B3 | **WebviewController 复用缺陷**：`private web` 是页面级单例（L38）。第一次「关闭登录」销毁 Web 后再点登录，会把同一个 controller 绑到新的 Web 实例 —— ArkWeb 规定一个 controller 只能绑一个 Web，二次绑定行为未定义，重试极可能白屏 | `AddProviderPage.ets` L38、L111 |
| B4 | `onOverrideUrlLoading` 和 `onLoadIntercept` **同时注册**，官方文档不建议二者并用，存在拦截时序冲突风险 | `AddProviderPage.ets` L116-121 |
| B5 | 没有「复制链接 / 用系统浏览器打开」的逃生口。打不开时用户无路可走 | 同上 |

补充：token 交换请求（`auth.openai.com/oauth/token`、`console.anthropic.com/v1/oauth/token`）
走 `@kit.NetworkKit` http，同样受直连限制 —— 即使网页能开，交换也可能超时。
OpenRouter（`openrouter.ai`）与 Kimi（`auth.kimi.com`）一般可直连，是目前唯二在无代理手机上可能全程走通的 OAuth。

### 症状 C：「模型明明读到了，就到不了选择模型」

| # | 根因 | 证据 |
|---|------|------|
| C1 | **添加流程里根本不存在选模型这一步**：`save()` 里 `refreshModels` 成功后把 `row.models` 更新、`row.model` 自动定为列表第一个（`refreshModels` L356-358），然后直接退回列表。选模型 UI 只存在于 `ProviderDetailPage`，但流程从不带用户进去 | `AddProviderPage.ets` L509-516、`ProviderStore.ets` L356-358 |
| C2 | Fold8/iOS 上聊天界面有模型切换器兜底，所以「加完不选」问题不明显；鸿蒙 `LocalChatPane` **没有任何模型/供应商切换 UI**，选模型的唯一入口藏在 设置→供应商→实例详情，链路彻底断开 | `LocalChatPane.ets` 全文无切换器 |

---

## 二、执行任务链路（定时任务 / 当身体）—— 两个 P0

### D. 冷启动没加载供应商档案（定时任务、当身体全灭）

- `LocalAgentEngine.run` 第一步检查 `providerStore.configured()`（L42），但 `configured()` 读的是内存里的 `instances` —— **必须先 `ensureLoaded(ctx)` 从磁盘加载**。
- 目前只有 UI 页面（LocalChatPane L430、供应商相关页）会加载。两条执行链都没有：
  - **定时任务**：`EntryAbility.markThenRun`（L88-99）只做了 `scheduleStore.mark → LocalTools.hydrate → run`。`LocalTools.hydrate`（LocalTools.ets L23-32）加载的是 memory/skill/collection/soul/env/mcp 六个 store，**不含 providerStore**。
  - **当身体**：`HarmonyMinisRouter.startTurn`（L200-217）只做了 `sessionStore.ensureLoaded → LocalTools.hydrate → run`，同样不含。
- 结果：app 冷启动后只要没进过「本机」聊天页或供应商页面，iPhone 发指令、定时任务到点，一律返回/记下「这台鸿蒙还没配供应商」。**这就是「不光聊天，执行任务也全部无效」的主根因。**

### E. 定时任务是黑洞：结果和报错全部丢弃

`EntryAbility.markThenRun` L93-99：

- `onDelta` 空实现、`onDone` 只推进下一条、`onError` 也只推进下一条；
- 输出不写 `sessionStore`、不发通知、`SchedulePage` 上没有任何运行记录/上次结果/失败原因；
- `scheduleStore.mark` 在**运行前**就把当天标记为已跑（L89），失败了当天也不会再试。

即使 D 修好，用户也无法知道任务跑没跑、跑出了什么。

### F. 定时任务只在前台 30 秒轮询

`armSchedule` 挂在 `onForeground`，`onBackground` 即清除（EntryAbility L28-34）。
锁屏/切后台不执行。这可以是有意的产品边界，但 `SchedulePage` 没有任何文案说明，用户会认为「定时坏了」。

### G. OAuth token 生命周期不完整

- 只有 OpenAI(Codex) 走了 `OAuthSession.ensure` 的刷新链路；
- **Anthropic OAuth 的 access_token 会过期，没有存 refresh_token、没有刷新逻辑** → 登录几小时后聊天/任务开始 401（表现为 failover 或「供应商都试过了」）；
- Kimi / xAI 设备码流程拿到的 refresh_token 同样没有持久化刷新。

### H. `refreshModels` 对所有类型都用 `Authorization: Bearer`

`ProviderStore.ets` L326-336：

- Gemini 需要 `x-goog-api-key`（或 `?key=`）→ 必 401/403；
- Anthropic 需要 `x-api-key` + `anthropic-version` → 必 401；
- OpenAI OAuth(Codex) 的 access_token 打 `api.openai.com/v1/models` → 401（Codex 后端没有 models 列表）。

添加流程里失败被静默吞掉（保留内置列表，尚可接受），但详情页「拉取模型」会直接报 `http 401`，用户又一次撞墙。

---

## 三、逐环节走查表

| 环节 | 现状 | 判定 |
|------|------|------|
| 选类型 → 选凭证 | 六家类型 + API Key/OAuth 双凭证列表正常 | ✅ |
| API Key 录入 | 输入、显隐、根路径、/v1 开关正常 | ✅ |
| OAuth 登录页打开 | 页内 Web 能拉起，但白屏无提示（B1-B5） | ❌ P0 |
| OAuth 回调捕获/换 token | 拦截 localhost 回调、PKCE 交换逻辑正确（协议层有测试） | ✅（依赖网络可达） |
| 保存 | upsert + 密钥入 asset 库正常 | ✅ |
| 保存 → 选模型 | **断头**：直接 back，不进详情页（A1/C1） | ❌ P0 |
| 新实例生效 | 不自动设为当前（A3），聊天页无切换器（C2） | ❌ P0 |
| 详情页拉模型 | OpenAI 兼容类可用；Gemini/Anthropic/Codex 头不对（H） | ⚠️ P1 |
| 本机聊天 | 进页面会 ensureLoaded，链路通；OAuth Codex 有刷新 | ✅ |
| 当身体（iPhone 指挥） | 冷启动没加载供应商（D） | ❌ P0 |
| 定时任务触发 | 前台 30s 轮询可触发；后台不跑且无说明（F） | ⚠️ P1 |
| 定时任务执行 | 同样没加载供应商（D）；结果/报错全丢（E） | ❌ P0 |
| 失败换（failover） | queue/shouldFailover 逻辑本身正确 | ✅ |
| Anthropic/Kimi/xAI OAuth 续期 | 无刷新（G），几小时后失效 | ⚠️ P1 |
| 语音 / 工具 / MCP | 不依赖供应商档案加载时序，与本次症状无关 | ✅ |

---

## 四、修复清单（待批准后动手）

### P0（先修，直接对应用户报告）

1. **保存后进详情页选模型**：`AddProviderPage.save()` 把 `router.back()` 换成
   `router.replaceUrl({ url: 'pages/ProviderDetailPage' })`（`ProviderLaunch.id` 已就位），
   详情页顶部加「选模型 → 用作当前供应商」引导；保存加成功提示。
   验收：加完 key 立即看到模型列表并可选。
2. **新实例自动设为当前**：`upsert` 后无条件 `setActive(row.id)`（或详情页显著提供一键激活）。
   验收：加完新供应商，本机聊天/任务立刻用它。
3. **执行链加载供应商档案**：最小改法是把 `LocalAgentEngine.run` 改为先
   `await providerStore.ensureLoaded(context)` 再查 `configured()` —— 一处兜底三条链路
   （本机聊天、当身体、定时任务）。
   验收：冷启动不进任何页面，iPhone 指令与定时任务都能跑。
4. **定时任务结果落地**：输出写入 `sessionStore`（会话名如「定时·任务标题」），
   `ScheduleTask` 记 `lastRunAt/lastResult/lastError`，`SchedulePage` 显示；失败不 `mark`（或标记失败态）。
   验收：任务跑完能在会话列表和定时页看到结果或失败原因。
5. **OAuth Web 打不开要有反馈和逃生口**：每次打开 new 一个 `WebviewController`（修 B3）；
   挂 `onErrorReceive` 显示「页面打不开：错误码 + 检查网络/代理」；顶栏加「复制链接」和
   「用系统浏览器打开」；OpenAI/Claude 登录前提示需可访问境外网络。
   验收：无代理手机上点登录能看到明确报错而非白屏，可复制链接换路径。

### P1

6. `refreshModels` 按类型定认证头（Gemini `x-goog-api-key`；Anthropic `x-api-key`+`anthropic-version`；
   Codex OAuth 实例跳过拉取、保留内置列表并在 UI 说明）。
7. Anthropic OAuth 存 refresh_token + 过期刷新（扩展 `OAuthSession` 支持多家）；Kimi/xAI 同理。
8. 配置页键盘避让：按钮固定底部或保证 Scroll 联动，避免被键盘遮住。
9. 去掉 `onOverrideUrlLoading` 与 `onLoadIntercept` 二选一（保留 `onLoadIntercept` 即可）。
10. 详情页对 OAuth 实例显示「重新登录」按钮，隐藏 API Key 输入框（现在文案混淆）。
11. `LocalChatPane` 顶部加模型/供应商快速切换器（对齐 Fold8）。
12. `SchedulePage` 写明「目前仅 App 在前台时执行」。

### P2

13. 后台定时（提醒代理/长时任务/推送唤起）调研。
14. 语音供应商模板对齐 Fold8。
15. 拉模型失败时用 models.dev 静态目录兜底（对齐 Android）。
16. 定时任务用量计入 `UsageStore`。

---

## 五、真机验证清单（修复后逐条过）

1. 全新安装 → 添加 OpenAI 兼容根 + API Key → 保存后**自动进详情页**，能选模型、已是当前供应商 → 本机聊天直接通。
2. 已有供应商 A 的情况下再加 B → B 生效（聊天用 B 或有明显切换入口）。
3. 无代理网络点「用 OpenAI 登录」→ 看到明确报错提示 + 可复制链接；有代理网络 → 登录页正常渲染、回调捕获、换 token 成功。
4. 同一页面连续「登录 → 关闭 → 再登录」三次，Web 每次都能渲染（验 controller 修复）。
5. Kimi 设备码全流程在无代理网络走通。
6. 杀掉 App → 冷启动停在首页不进任何设置页 → iPhone 发指令 → 正常回复。
7. 设一条 2 分钟后的定时任务 → 冷启动等待触发 → 会话列表出现结果；断网重试 → 定时页能看到失败原因。
8. Gemini / Anthropic API Key 实例在详情页拉模型成功（验认证头）。

---

## 六、网络前提（需要在 UI/README 明示）

| 提供商 | 登录/接口域名 | 大陆直连 |
|--------|--------------|---------|
| OpenAI（OAuth + API） | auth.openai.com / chatgpt.com / api.openai.com | ❌ 需代理 |
| Anthropic（OAuth + API） | claude.ai / console.anthropic.com / api.anthropic.com | ❌ 需代理 |
| Gemini | generativelanguage.googleapis.com | ❌ 需代理 |
| xAI | auth.x.ai / accounts.x.ai / api.x.ai | ❌ 需代理 |
| OpenRouter | openrouter.ai | ⚠️ 通常可达 |
| Kimi | auth.kimi.com / api.kimi.com | ✅ |
| 第三方兼容根（DeepSeek、MiMo 等） | 各自域名 | ✅ 多数可达 |

手机端没有系统代理时，上面 ❌ 的家族即使代码全对也走不通 —— 这必须作为产品文案告知，
而不是让用户对着白屏猜。

---

## 七、落地状态（0.3.0-alpha.4 / 100009）

| 条目 | 状态 |
|------|------|
| P0.1 保存后进详情页选模型 | 已落地 `AddProviderPage.save` → `replaceUrl` 详情页 |
| P0.2 新实例自动当前 | 已落地 `ProviderStore.upsert` 新建时 `activeId = row.id` |
| P0.3 执行链先加载供应商 | 已落地 `LocalAgentEngine.begin` 先 `ensureLoaded` |
| P0.4 定时结果落地 | 已落地会话「定时·标题」+ `lastResult/lastError`，失败不 mark |
| P0.5 OAuth 白屏反馈 | 已落地 `OAuthLoginSheet`：新 controller、错误文案、复制、系统浏览器 |
| P1.6 refreshModels 认证头 | 已落地 Gemini / Anthropic / Codex 跳过 |
| P1.7 OAuth 续期 | 已落地 Anthropic / Kimi / xAI refresh |
| P1.8 键盘避让 | 已落地「添加供应商」固定底部 |
| P1.9 只留 onLoadIntercept | 已落地 |
| P1.10 详情页重新登录 | 已落地，OAuth 不再露出 Key 框 |
| P1.11 聊天切换器 | 已落地 `LocalChatPane` 顶栏 |
| P1.12 定时前台说明 | 已落地 |
| P2.13 后台定时调研 | 见 `docs/HARMONY_BACKGROUND_SCHEDULE_2026-08-20.md`，本版保持前台 |
| P2.14 语音模板 | 已落地添加页 Seven 家模板 |
| P2.15 models.dev 兜底 | 已落地，再不行用内置列表 |
| P2.16 定时用量 | `LocalAgentEngine` 成功回合已计入 `UsageStore` |

---

## 八、真机证据（Pura X Max，至 0.3.0-alpha.14 / 100019）

| # | 清单原文 | 证据 | 判定 |
|---|---------|------|------|
| 1 | 全新安装 → Key → 详情选模型 → 聊天通 | 非全新安装。有道兼容根已在详情选 `g-5.6-s` 并聊天通。后加的 Gemini/Anthropic 保存后进了详情。 | 部分（缺全新覆盖安装） |
| 2 | 已有 A 再加 B | B 新建即当前；聊天顶栏可切换。alpha.12 先点供应商名再展开模型。 | 通过 |
| 3 | 无代理 OpenAI 登录报错+复制；有代理走通 | 无代理：`about:blank` 后 8 秒「页面打不开」+ 已复制。有代理换 token 未验。 | 部分（缺境外代理） |
| 4 | 登录→关闭→再登录 ×3 | 三次重开都有关闭登录/复制链接/Web，未崩。 | 通过 |
| 5 | Kimi 设备码全流程无代理 | alpha.13：Web 打开 `https://www.kimi.com/code/authorize_device`，设备码 `JVAE-0KUT`，手机号登录页渲染。alpha.14 改为优先带 `user_code` 的完整确认 URL；包已装上，锁屏未能冷启动核对弹窗和带码页。换 token 仍需你登录确认。 | 部分（确认页已开，带码 URL 与 token 待解锁后验） |
| 6 | 杀进程冷启动首页，iPhone 指挥 | 首页冷启动后会话「只回一个字：身」→「身」。中继 events 曾 502，本机已落地。 | 通过 |
| 7 | 2 分钟前台定时有结果；断网见失败 | 成功：「定时·审计两分钟」→「到」。失败：关掉当前供应商后「定时·审计失败」→「这台鸿蒙还没配供应商」，失败不 mark。不是拔网。 | 通过（失败用关供应商代替断网） |
| 8 | Gemini/Anthropic 详情拉模型（认证头） | 假钥匙点「从上游拉取」得「已拉取 39/13 个模型」（兜底，非上游 200）。`modelsAuthHeaders` 有单测。真钥匙未验。 | 部分 |

P0–P2 源码均在。当前船 **0.3.0-alpha.14 / 100019** 已覆盖安装。alpha.13 确认页已打开（`JVAE-0KUT`）；本版改为优先 `verification_uri_complete`，登录后不用手抄设备码。装机后因锁屏未能冷启动核对「本次更新」，解锁后再验 Kimi 带码确认页。
