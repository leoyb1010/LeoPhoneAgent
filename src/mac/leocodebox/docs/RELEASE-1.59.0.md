# leocodebox 1.59.0 — 自有内核 · 写/执行工具(pillar 3 · 默认关·逐次开启)

内核从「只读问答」升级到能**真正干活**:新增 `write_file`(改文件)与 `run_shell`(跑命令)两个工具。安全为先:**两者都默认关**,只有在**单次运行显式勾选**时才提供给模型;不勾选则行为与 1.58 完全一致(纯只读)。

## 多了什么
- **write_file**:在根目录内创建/覆盖 UTF-8 文本文件(自动建父目录),大小上限 256 KiB,同样受根目录沙箱约束(词法归属 + realpath 二次校验,拒绝逃逸)。
- **run_shell**:以根目录为工作目录执行命令,**30s 超时 + 32 KiB 输出上限**;对少数最具破坏性的模式(`rm -rf`、`sudo`、`mkfs`、fork bomb、写 `/dev/sd*`、`shutdown/reboot` 等)做 denylist 兜底(说明:这不是安全沙箱,仅拦最不该出现的命令——正因如此才默认关、逐次开)。
- **逐次授权 + 纵深防御**:端点 `POST /kernel/run` 接受 `allowWrite`/`allowExec`(默认 false)。关时这两个工具**根本不进 specs**;即便模型硬调,executor 也二次拒绝。系统提示据此告知模型可用工具与"先说明再动手、最小改动"。
- **卡片 cool-simple 开关**:内核卡加两枚小复选框「允许写文件 / 允许执行命令」(默认不勾);勾选后显示一行醒目提示,请在可回滚目录使用。

## 安全与边界
- **默认只读**;不勾选 = 与 1.58 行为一致。写/执行是**每次运行**的显式选择,不是全局常开。
- **与你日常在用的 claude/codex 持平**:它们本就会改文件/跑命令;内核只是把同类能力做成本机自有、可沙箱、可上限、默认关。
- 复用本地 token 鉴权 + 活跃 claude 节点;真实 key 不进前端。

## 验证
- 门禁全绿:typecheck 0、ESLint 0、client 71/71、server **323/323**、生产构建通过。
- 新增单测:工具门控(关时不入 specs 且 executor 拒绝;开时入 specs)、write_file 写入根内成功且拒绝 `..` 逃逸、run_shell 实跑 `echo` 成功且 `rm -rf` 被 denylist 拦截。
- 装机后:端点接受新标志(无活跃节点仍诚实 409)。

## 后续
- 内核流式事件(边跑边显)、注册为第 6 家 provider;opencodex shadow-call 观测、pi Skills 等增补。

## 下载校验
- DMG SHA-256:`0e41203e264f817026ecef64372a194dec56d57d2e03148b7196a0001a54f3da`
- ZIP SHA-256:`daf90a3a4f6e1c111c34d03847e48f9180bfa8bc53c4c667ed8fdae14bd2c465`
- `latest-mac.yml` SHA-256:`90cd3e06a27ad5738633e4e715b6bcce4a7931b16b81d7537fd8fd1ea7d00f59`

> 注:本版 DMG 未做窗口背景美化(本机 Finder 自动化权限被系统重置,-1743),纯功能包,不影响安装/签名/公证/热更新。
