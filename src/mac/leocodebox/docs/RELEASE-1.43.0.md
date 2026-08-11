# leocodebox 1.43.0

一个融合版:把「唤醒与全景」「配置安全」「Skill 军械库」「环境诊断」一次性交付,并清理了一批死码。全程 301 项自动测试 + 对抗式审查(修掉 1 个高危并发回归)。

## 多了什么

**唤醒与全景**
- ⌥Space 全局唤醒:在任意应用按 ⌥Space 显隐主窗;默认关、可关,快捷键被占用时自动回滚并提示。
- 状态栏更新角标:有可用更新(蓝)/待重启(琥珀)一眼可见,点击直达更新卡。
- 测速历史 sparkline:每个接口端点保留最近 20 次测速的趋势折线,一眼看出节点在变快还是变慢。
- Handoff 回程票:⌘K 新增「回到交接来源」,交接后能一键跳回原会话。
- MCP 只读全景板:把 claude/codex/cursor/opencode 四个 CLI 已装的 MCP 服务器按名去重汇总,看清「哪个装在哪些 CLI」。

**配置安全**
- 覆盖 `~/.claude.json` 等整份配置前,先把旧内容备份到 `~/.leocodebox/config-backups`,一次误改可恢复。

**Skill 军械库**
- Skill 软删除:删除/覆盖 skill 从「硬 rm -rf」改为移入回收站(`~/.leocodebox/trash`),可还原,30 天自动清理。
- Skill 跨 CLI 一键分发:同一个 skill 一次装到所有支持的 CLI,单个 CLI 不支持时软降级不阻断其余。

**环境诊断与安全(融合 QwenPaw 的轻量能力)**
- Doctor 环境自检:CLI 装没装/能不能跑、Leoapi 节点 Key 配没配/最近测速通不通,逐项 ok/warn/fail。
- 静态安全扫描:启用 skill/MCP 前,扫描 prompt 注入、硬编码密钥、数据外泄、危险命令等高信号风险,warn 模式 + 白名单,只提示不拦截。

新增可用接口:`GET /leocodebox/doctor`、`POST /content-safety/scan`、`POST /skills/global`(跨 CLI 分发)。

## 更稳的

- 动效地基:统一 `--ease-*`/`--elevation-*`/`.skeleton` 设计令牌,深色模式阴影用 `:root.dark` 高特异性覆盖保证生效;switch 页与主界面动效令牌同源(有回归测试守约)。
- 死码清理:删除 7 个从未接线的死文件(含 313 行的 commandParser)与 14 处未引用导出,净减约 770 行。
- 对抗式审查修掉 3 个真实缺陷:① 配置写入的读回校验会在并发下把刚提交的写回滚(复现 418/500),已改为无竞态的备份方案;② 回收站清单落盘顺序导致的孤儿;③ 安全扫描漏掉 `rm -rf /*` 等最危险形式。

## 刻意没做的

- 没抄 QwenPaw 的臃肿件:多 IM 渠道推送、重型向量长期记忆、自研模型运行时、多智能体编排、Web IDE、REST 服务器、遥测。
- MCP Registry 在线浏览、MCP 健康检查(会 spawn 用户任意命令)、Skill 删除按钮/Hub UI/Agent Profile 启动——这些依赖外部网络、Electron 主进程或 GUI 交互,留待人工验证后再上,不在本版塞半成品。
- gemini/grok/hermes 的 MCP 适配器、.mcpb 单一生态格式、8 语言机器翻译——无真实需求或属臃肿,不做。

## 验证

- ESLint 0 警告,客户端与服务端 TypeScript 检查通过,生产构建通过。
- 自动测试:desktop 27、client 57、server 217,共 301 项通过。
- 对抗式审查(多 agent + 逐条证伪)确认并修复 3 个缺陷,含 1 个高危并发回归。

## 下载校验

- DMG SHA-256:`1d52f0924351b18f37a1b0515342750878ec40884db43795af5f9d68cfdd8a1a`
- ZIP SHA-256:`7d7e8ca7a189af1f796be705f037f10e5c83d3954997e0ab01be59611bf9d35b`
- `latest-mac.yml` SHA-256:`1eaf4fbb702aecfe35e2124c59b267e57d385e9ce9fa96076099760a02ecccef`
