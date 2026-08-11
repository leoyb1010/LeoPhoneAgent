# leocodebox 1.49.0

「Grok 全能力接入」——xAI 正式开源 Grok Build CLI 后,把它接成和 Claude/Codex/Cursor/OpenCode 同级的一等运行时:在产品里直接新建 Grok 对话、流式看输出、断点续聊。同时修掉「本机智能体」多副本误报,并把新建对话的模型选择折叠成「先选 CLI、再选模型」两步。全程门禁全绿 + 对抗式审查 + 隔离环境真机跑通(真实 grok 二进制端到端)。

## 多了什么

**Grok Build 一等运行时(L3,产品内全能力使用)**
- 新建对话可直接选 Grok,和其他 CLI 一样流式渲染 thinking / 正文、状态与用量,断点可续聊(resume)。
- 会话 id 由本端用 `--session-id` 主动指派并在首字节前广播,续聊走 `-r`;权限模式(default / acceptEdits / bypassPermissions / plan)直通 grok 的 `--permission-mode`。
- 历史读盘按 grok 的真实落盘规则(`~/.grok/sessions/<realpath(cwd) 编码>/<id>/chat_history.jsonl`)解析,把 assistant 的 tool_calls 与 tool_result 配对合并渲染。
- 能力自洽:MCP / 会话同步声明为 unsupported,全局「向所有智能体加 MCP」会正确跳过 grok(不再产生一行失败)。

**「本机智能体」多副本误报修复**
- 原来只要 PATH 里有多份 CLI 副本且版本不一,每台机器都提示「有 N 份副本且版本不一」。现在只在**你实际会跑的那一份(PATH 最前)落后于某个被它遮住的更新副本**时才提示——用语义化版本比较判定,单副本机器永不再报。

**新建对话模型选择:两步折叠**
- 原来一个弹层平铺所有 CLI 的全部模型,太长。现在第一步只列 CLI(带各自当前模型摘要),点进去第二步才显示该 CLI 的模型,带返回按钮;打开时永远回到第一步。

## 更稳的(对抗式审查 + 真机验证)

- **隔离环境真机端到端**:在临时目录(无仓库、无 .env,杜绝敏感数据上传 xAI)对**真实 grok 二进制**跑通:新建会话拿到 uuid、流式输出、**恰好一个** complete(exit 0)、续聊命中同一会话上下文、落盘 history 存在。
- **realpath 修复**:实测发现 grok 按 cwd 的 realpath 落盘(macOS `/var`→`/private/var`);历史目录改按 realpath 编码,否则带软链的项目路径会读不到会话。附回归单测(软链解析 + 不可解析回退)。

## 验证

- ESLint 0 警告,客户端与服务端 TypeScript 检查通过,生产构建通过。
- 自动测试:desktop 27、client 65、server 260(含 grok 6 项:live 归一化 / on-disk transcript 配对 / 合成用户轮跳过 / 权限映射 / realpath 目录解析 ×2),共 352 项全绿。
- 隔离环境真机实测:真实 grok 二进制新建+流式+单一 complete+续聊+落盘,断言全通过。
- 对抗式审查:多 agent 逐条证伪 grok 运行时 / 注册表 / 多副本修复 / 两步选择器 / prop 串联。

## 下载校验

- DMG SHA-256:`235a8c1ad4057696a01471f3e025345c3b0c3f34f9bb878bef35ea1fdf944378`
- ZIP SHA-256:`cbdcc3fa21d7f7238a66d01dc9d207c2be1e7984c85e3de69a398703022740e1`
- `latest-mac.yml` SHA-256:`4f2bc3f44bed9babc3b74ffc8b057a95c31d1e80ed178e1670895935517fe7d4`
