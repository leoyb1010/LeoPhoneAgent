# leocodebox 1.78.0

## 本次交付

- 1.77.0 装上后，原来那个中途崩掉的对话仍会整栏显示「此区域暂时无法加载」。点重新加载会立刻再摔回去。
- 根因：整栏共用一个 ErrorBoundary；消息里的 `$PATH` / 半截公式会让 KaTeX 默认抛错，Reload 只是把同一条消息再渲染一遍。
- 这一版公式不再抛；一条坏消息只挡它自己，会话其余内容还能看。
- API Key 读出来的模型改完会真正用来发。

## 发布边界

Developer ID Application 签名后上传 `leocodebox-updates`（`v1.78.0` + `latest-mac.yml` + ZIP + DMG）。本机钥匙串没有 `leocodebox` 公证 profile，本版不 stapler。热更新仍走同一 TeamIdentifier。本机 `/Applications` 只留这一份。
