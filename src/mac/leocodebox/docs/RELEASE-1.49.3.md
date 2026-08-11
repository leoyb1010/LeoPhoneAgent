# leocodebox 1.49.3

热修复:Leoapi 改接口(自定义 key/url)在某些机器上「看着改了、实际没变」,Claude Code / Codex 仍调用旧端点,被锁死。

## 修了什么

**[严重] 改 Leoapi 接口不生效,被旧配置锁死**
- 根因:在装了 cc-switch(或手动 `export` 过 `ANTHROPIC_*`)的机器上,登录 shell 里残留的旧 `ANTHROPIC_BASE_URL`/key 会被本 App 从登录 shell 导入进进程环境(`electron/runtimePath.js` 的 Agent env 白名单)。而 **claude 2.1 对进程环境变量的优先级高于 `settings.json`**(本版实测确认),于是这个旧值盖过 Leoapi 往 `settings.json` 写的一切——在 Leoapi 改了接口也不起作用。
- 旧逻辑的 overlay 只「设置」活跃节点自身带的变量,不「清除」它没带的;活跃节点若没填 baseUrl,旧的 shell `ANTHROPIC_BASE_URL` 就漏过去了。
- 修复:新增 `applyActiveSwitchEnv`——**只要有活跃 Leoapi 节点,先清空全部受管的 `ANTHROPIC_*` / `OPENAI_API_KEY`,再套上活跃节点的值**,让活跃节点完全接管(空 baseUrl 正确回落官方端点,而不是继续用旧值)。没有活跃节点时原样不动,保留「本机原配置」。claude 与 codex 两个运行时都改用它。

## 验证(三重,含真机)

- **优先级实验(真 claude 2.1.211)**:进程环境的 `ANTHROPIC_BASE_URL`(:39001)胜过 `settings.json.env`(:39002)——claude 命中 39001。确认根因。
- **端到端(真 claude + 本修复)**:模拟 shell 残留旧端点 :39011 + 活跃 Leoapi 节点 :39012,跑通实际修复代码后 claude **命中 39012、未命中 39011**,旧值被清、新值生效。
- **单测 5 条**:清 stale / 完整接管 / 无活跃不动(本机原配置)/ codex / 坏 active id 返回空 overlay。
- 门禁全绿:typecheck / lint(0 警告)/ build;测试 358(desktop 27 + client 65 + server 266)。

## 下载校验

- DMG SHA-256:`1460b2dc0d6292225d13e45b3e22ec3e979b6a932e4002868981bd046094102f`
- ZIP SHA-256:`87bc3f903717c719fc31e992a3782d81f78ea2839e06892d65578ac655c089fb`
- `latest-mac.yml` SHA-256:`a81c45fa511a452f84f0473df420bd6c8bad0076bd98dd6dccdcad1e6721e31f`
