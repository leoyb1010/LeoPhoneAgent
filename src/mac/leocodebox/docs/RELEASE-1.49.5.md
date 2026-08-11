# leocodebox 1.49.5

热修复:打包应用里「本机智能体」读不出状态(spawn EBADF),以及 Grok 图标用了占位花括号。

## 修了什么

**[严重] 本机智能体状态读取失败:`spawn EBADF`**
- 现象:设置 →「本机智能体」顶部红字「无法读取本机智能体状态: spawn EBADF」,各 CLI 的安装/版本/登录状态全读不出来。
- 根因(两层):
  1. CLI 探针共享函数 `runCliCommand` 用 `execFile` 继承默认 stdin 管道。从访达/Dock 启动的打包 GUI 应用**没有真正的 stdin**,libuv 给子进程建 stdin 管道时失败 → `spawn EBADF`(终端启动有 stdin 就正常,故单测/终端跑测不出)。
  2. 更深一层:状态面板**一次并发 ~28 个探针**(7 个 CLI × which/which-a/--version)。打包 GUI 应用下并发 spawn 会随机命中 libuv 的 fd 竞态、对其中一部分报 `spawn EBADF`——于是工具**非确定性地掉出来**(实测 4 路并发仍会挂,完全串行才稳)。
- 修复:`runCliCommand` 改写为 `spawn` + `stdio: ['ignore','pipe','pipe']`(stdin 走 /dev/null)+ 手动收集/超时;并给**短探针加串行门**(一次一个 spawn,避免并发 fd 竞态);长时安装/更新(>30s)绕过该门,避免占住唯一槽位阻塞状态刷新。
- 真机验证(双击启动的已签名正式包):`cli/status` 返回 `success:true`、**7 个 CLI 全部识别、0 错误**(此前:整块 `spawn EBADF`)。

**Grok 图标换成官方标识**
- `GrokLogo` 之前是占位花括号 `{}`(lucide Braces)。换成 xAI Grok 官方双弧标识 SVG,用 `currentColor` 适配明暗主题,并移除源 SVG 里重复的 `id`。真机核对:聊天/侧栏/设置里 grok 显示为官方标识。

## 验证

- 门禁全绿:客户端/服务端 typecheck、ESLint 0 警告、生产构建通过;测试 366(desktop 27 + client 70 + server 269)。
- 真机双击启动已签名正式包:本机智能体 7 个 CLI 全部识别、无 EBADF;Grok 图标为官方标识。

## 下载校验

- DMG SHA-256:`57d70d90a57d4707b82ae2232d9e8d27dcdbb0f00854b37e2e3e93d3d8175288`
- ZIP SHA-256:`89b7230125878f1df2f3c7d99ee26c794dc50a51f5e79902f5692ce6e0c8b7f3`
- `latest-mac.yml` SHA-256:`e9ca1b1e10cd1077fe4f842448d6c25c1fa30157405f1104748c9d19701949a4`
