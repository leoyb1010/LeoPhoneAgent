# leocodebox 1.69.0 — 额度改成问官方要,不再靠猜

1.68.0 的菜单栏额度面板是「思路借自 CodexBar」的简化版:只会**被动扫本机日志尾部**,
等服务端偶然在会话日志里下发一帧 `rate_limits`。捞到的可能是几小时前的旧数字,捞不到
就只能拿本机 token 统计去凑。这一版把 CodexBar 真正的做法吸收进来:**拿本机已有的
登录态,直接向官方接口要当前额度**。

## 数据来源:从"扫日志"到"问官方"

| | 1.68.0 | 1.69.0 |
|---|---|---|
| Codex | 扫 `~/.codex/sessions/*.jsonl` 尾部捞 `rate_limits` 帧 | `GET chatgpt.com/backend-api/wham/usage`,token 取自 `~/.codex/auth.json` |
| Claude | 扫 `~/.claude/projects/*.jsonl` 统计近 5h token(**估算**) | `GET api.anthropic.com/api/oauth/usage`,凭据**钥匙串优先** |
| 其余 | 笼统的"未接入" | 逐家写明缺哪一样凭据 |

本机实测(2026-08-18):

```
Codex        status=ok  source=oauth  primary=33%@7d  +1extra  plan=pro
Claude Code  status=ok  source=oauth  primary=30%@5h  secondary=24%@7d  plan=claude_max
```

### 钥匙串优先不是可选项

本机 `~/.claude/.credentials.json` 里的 token **已过期 13 天**,直接拿去调接口只会
拿到 401;而钥匙串 `Claude Code-credentials` 里的是有效的。所以凭据发现按
**钥匙串 → 文件**的顺序,并且**每个来源用之前先查 `expiresAt`**,过期就跳过换下一个。
两种 blob 结构(带不带 `claudeAiOauth` 外层)都要能解析。

### 不硬编码窗口白名单

Claude 的接口除了 `five_hour` / `seven_day`,还会返回 `seven_day_opus`、`seven_day_sonnet`,
以及 `nimbus_quill`、`tangelo`、`cinder_cove` 这类内部代号窗口。判据不是白名单,而是
**「有数值 `utilization` 且有可解析的 `resets_at`」才算真实窗口** —— 代号窗口自然被滤掉,
将来 Anthropic 新增窗口也能自动接住。

同理,Codex 的窗口长度**一律从 `limit_window_seconds/60` 算**,不按 lane 位置假设:
本机这个账号的 `primary_window` 就真的是 7 天窗口,不是 5 小时。

## 面板:按 CodexBar 的卡片规格重做

310px 卡片,`Header → Divider → Usage → Credits → Cost → Details` 固定顺序。
每个额度窗口一行:

```
标题 + 剩余百分比                          2 小时 15 分后重置
[━━━━━━━━━━ 进度条(高 6px) ━━━━━━━━━━]
超前 11% · 预计 3 小时 20 分后用光(25% 风险)
```

进度条不只是一根填充条:

- **配速位置**:按当前时间进度算出"本该用到哪",在条上画出来。超前是红的、落后是绿的,
  正常节奏不画。
- **警戒刻度**:50% / 20% 两道缺口。
- **工作日刻度**:只在 7 天窗口上画。

### 配速:回答"用得完用不完"

光给百分比是不够的 —— 剩 40% 到底够不够撑到重置,取决于你烧得多快。这一版算出
超前/落后多少、还能撑多久、预计几点用光、多大风险。数据不足以下结论时(没有重置时间、
窗口已过、时间进度不足 3%)**返回空,而不是给一个看起来很确定的 0**。

## 权威与估算,永远分开

面板上每一家都带来源标注:接口拿到的标「权威」,接口失败回落到本机日志统计的标
「本机统计」。**把估算值摆成配额是最容易骗到自己的做法** —— 这条原则 1.68.0 就写了,
这一版把它落到了数据结构里(`source` 字段),而不只是文案。

读不到就明说读不到:

- **Gemini**:本机登录方式是 `gemini-api-key`,个人配额接口只对 `oauth-personal` 开放
- **Cursor**:用量只在 cursor.com 后台,要先拿到浏览器会话 cookie 或官方 API
- **Grok**:额度要查 xAI 控制台,缺一个可用的 API key 或会话凭据
- **OpenCode**:按自配的上游计费,没有统一额度接口可读

不填 0、不编百分比、更不会让缺的那几家从菜单里消失。

## 发版更新提示:加了自动闸门

1.68.0 版本号 bump 了、`docs/RELEASE-1.68.0.md` 也写了,唯独漏了
`LEO_RELEASE_NOTES` 条目 —— 装上机器弹不出"本次更新"。更糟的是
`currentReleaseNote()` 当时会 fallback 到上一条,**把"漏写"伪装成"弹得好好的"**。

三处一起修:

1. `npm run verify:release-notes` 挂在 `desktop:dist:mac:signed` 链首,版本号与更新说明
   对不上就**直接构建失败**
2. 缺条目时明说"本版本更新说明缺失",不再冒充上一版内容
3. 根 `CLAUDE.md` 里 Mac 那条指的还是早就废弃的 `resources/release-notes` JSON 路径,
   照着做必然漏 —— 已改成真实路径

铁律本身也升格成全端通用第一条:**版本号 bump 了却弹不出提示,或者弹出来是上一版的
内容,都算发版失败。**

## 安全

凭据全程**只读**:不写回、不刷新、不落日志。测试里有一条断言 —— 序列化后的快照里
**不允许出现任何 access token**。

## 验证

- 全量测试 **518 通过 / 0 失败**(desktop 34 + client 112 + server 372)
- 端到端实跑 `readAiQuota()`,Codex 与 Claude 均返回真实权威额度(见上表)
- 签名、公证、staple 全绿,Gatekeeper 判定 `Notarized Developer ID`

## 已知未完成

- **Gemini** 的 token 刷新流程没做。本机 `oauth_creds.json` 已过期约 3 个月,上游的做法是
  从 gemini-cli 内部 `oauth2.js` 正则抠 client_id/secret,**任何一次 CLI 升级都会让它失效**。
  完整方案与 `retrieveUserQuota` 端点细节写在 `readGeminiSnapshot()` 的注释里,留待下轮。
- **菜单栏图标**仍是 Unicode 方块计量,上游是 18×18 位图双条量表(上条 session、
  下条 weekly)。下拉菜单已对齐,图标本身下轮再说。
- Cursor / Grok / OpenCode 需要一层凭据采集(浏览器 cookie 或各家后台 API),这一版
  只把缺口写清楚,没有实现。
