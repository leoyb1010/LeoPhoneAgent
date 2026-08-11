# leocodebox 1.44.0

「看得见」——把 1.43 已建好但埋在设置深处或只有 API 的能力接进界面,并修掉一个用户实测的真 bug。全程门禁全绿 + 对抗式审查(修 4 个确认缺陷)。

## 多了什么

**MCP 和 Skills 升为设置一等 Tab**
- 以前 MCP、Skills 藏在「设置 → 智能体 → 选中某个 Agent → 切分类」第三层,不好找。现在它们是设置侧栏的顶层一等 Tab,自带 CLI 选择器,打开设置一眼可见、可管。⌘K 也能直达。

**环境体检 Doctor 健康灯**
- 状态栏新增健康灯:一眼看出 CLI 装没装/能不能跑、Leoapi 节点 Key 配没配/最近测速通不通(全 ok 绿 / 有注意 琥珀 / 有异常 红)。点击向上弹逐项检查单;⌘K「环境体检」同样可开。

**Skill 安装前静态安全扫描门**
- 安装 skill 时,先扫 SKILL.md 及文件夹内附带脚本的 prompt 注入 / 硬编码密钥 / 数据外泄 / 危险命令。高危红条阻断、需二次确认「仍要安装」才继续;中低危黄条提示。只提示不硬拦(确认式智能)。

## 更稳的

- **修:Grok Build 无法新建对话**(用户实测报的真 bug)。根因:「Grok Build」不是会话 provider,而是 Cursor 的 model `grok-build-0.1`,经硬编码兜底 model 表泄进新会话选择器;选它会跑 `cursor-agent -p --model grok-build-0.1` 被 CLI 拒绝,对话建不起来。修复:在 Cursor model 列表的 live 与 fallback 两条路径都滤掉 `grok-build*`,不再向用户提供这个注定失败的选项(保留 grok-4.3 等一般模型)。
- **browser-use-mcp 孤儿进程 watchdog**:退出 App 时残留的 browser-use-mcp 子进程,现在会在父 Agent CLI 消失后自杀,不再残留。
- 回收站 / 配置备份读接口(`GET /recycle`、`POST /recycle/:id/restore`、`GET /config-backups`),为后续回收站页面铺好水管;restore 对已还原的 id 返回干净 404、备份列表不泄露绝对路径。
- 对抗式审查修掉 4 个缺陷:扫描门漏扫文件夹附带文件(安全)、restore 500 泄路径、备份名泄绝对路径、8 语言标签回退显示中文。

## 刻意没做的(留待 1.45)

- MCP 资产行的「每 CLI 一键开关 chips」、Skill 删除按钮 + 5 秒可撤销 toast、回收站页面 UI、首启导览——这些交互 UI 需要更多真机迭代,不在本版塞半成品。
- 不把 grok 扶正为会话 provider(它无运行时适配器,定位是仅本机发现/版本管理)。

## 验证

- ESLint 0 警告,客户端与服务端 TypeScript 检查通过,生产构建通过。
- 自动测试:desktop 27、client 65、server 227,共 319 项通过。
- 对抗式审查(多 agent + 逐条证伪)确认并修复 4 个缺陷,0 误报。

## 下载校验

- DMG SHA-256:`41293ad1970804a42b04a73fafd6fd310d40758387a58066a06076ad4f80cecb`
- ZIP SHA-256:`08f427ce81235fcb71784d21c9d9ed91f5ed0efc9ec5b93a064c255768011aae`
- `latest-mac.yml` SHA-256:`d08de82a5fe80f707949fa53b55d271dc2152b033903c3f552d929362a67b5bb`
