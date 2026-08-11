# leocodebox 1.49.8

上游吸收版:扫描两个上游参考产品(cc-switch 未发版分支、claudecodeui v1.36.2/v1.36.3)后,把适用于我们的三项修复移植进来。均带测试。

## 吸收了什么

**[安全] 刷新 token 存储前校验(自 claudecodeui 1.36.2 #971)**
- 原来 `X-Refreshed-Token` 响应头拿到就直接写入 localStorage,零校验;被注入/畸形的值可能覆盖登录 token。
- 现在只接受标准 JWT 形状(三段 base64url)的 token,两个存储点(apiClient + 文件上传 XHR)统一走 `isValidRefreshedToken`。附正反两条单测。

**Codex 子代理会话不再混入侧栏(自 claudecodeui 1.36.3)**
- Codex ≥0.144 的 spawn_agent/review/compact 子线程会把自己的 rollout 写进同一个 sessions 目录;同步器现按 `thread_source: "subagent"` 或对象型 `source.subagent` 标记跳过,只收录顶层用户会话。附单测(两种标记 + 正常会话对照)。

**首启动语言跟随系统(自 cc-switch 未发版修复)**
- 无保存偏好时按系统 locale 匹配支持语言(zh-CN/zh-TW/en/ja/ko/de/fr/it/ru/tr;zh 细分台湾/香港→zh-TW);用户显式选择永远优先;匹配不上仍回落 zh-CN(保住中文默认定位)。

## 判定不适用而放弃的

- cc-switch「tool parameters 强制 object」修复:那是它代理层的坑,我们的 Leoapi 不转发 tools 定义(已核实),无处适用。
- claudecodeui 的 codex-sdk ^0.144.0 升级:我们已在该版本,无需动作。

## 验证

- 门禁全绿:typecheck、ESLint 0 警告、生产构建;测试 369(desktop 27 + client 71 + server 271),含 3 条新增单测(JWT 校验正/反、子代理跳过)。

## 下载校验

- DMG SHA-256:`9c5ab63bcf7a48d74f6a847f075fc3c08d08a890df426969990bd93428961af2`
- ZIP SHA-256:`98d1fc55bd1fca43c75474fdea4014172b1e2271cfb1a9a39d0180832cf59b96`
- `latest-mac.yml` SHA-256:`04dc0cd68a69e93d70898bfdb71f7d6af698f05ba2a631e274d0ae0a3ed253d3`
