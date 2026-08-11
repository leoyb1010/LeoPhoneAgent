# leocodebox 1.57.0 — pi 自有内核 v0 · 运行时内核(融合第四步 · pillar 3 起步)

融合 pi 的 `pi-agent-core` 思路:leocodebox 有了**自己的 Agent 运行时**,不再只依赖外部 claude/codex CLI。v0 是内核的**运行时核心 + 本机端点**:一个真实的 Agent 循环,按 Anthropic tool-use 协议驱动模型 → 执行工具 → 回灌结果 → 直到模型收口或触及步数上限。

## 多了什么
- **内核 Agent 循环(`pi-kernel/kernel.ts`)**:真实的 tool-use 循环。所有外部依赖(模型调用、工具执行)全部**注入**,因此控制流是纯函数、可离线单测。步数上限兜底,工具抛错转成 `is_error` 结果回灌(与真实工具错误一致),永不把循环拖死。
- **只读沙箱工具(`kernel-tools.ts`,v0 安全为先)**:`read_file` / `list_dir`,全部**限定在任务根目录内**——逐路径解析 + 跟随符号链接后再校验归属,`..` 与符号链接都无法逃逸。v0 **不写文件、不执行命令**,安全由构造保证,仍然实用(代码问答、"X 在哪里处理")。
- **接活跃节点的真实模型调用(`kernel-client.ts`)**:走 Anthropic Messages + tools 协议,复用 provider store 里**当前活跃的 claude 节点**(不新增凭据面)。`parseModelResponse` 为纯函数、单测覆盖。
- **本机端点**:`POST /api/leocodebox/kernel/run`(本地 token 鉴权)。只读工具 + 根目录沙箱 + 步数上限,一次授权调用也无法写、无法执行、无法读根目录之外。

## 安全与边界
- **v0 只读**:没有写文件 / shell 工具,安全由构造保证。
- **根目录沙箱**:词法归属 + realpath 二次校验,拒绝 `..`/符号链接逃逸。
- **不新增凭据面**:复用现有活跃 claude 节点;无活跃节点时端点返回 409,不臆造。
- **与现有 CLI 执行并存**:内核是新增的自有能力,不替换、不影响 claude/codex 会话。

## 验证
- 门禁全绿:typecheck 0、ESLint 0、client 71/71、server **320/320**、生产构建通过。
- 新增单测(纯逻辑,无网络/无磁盘依赖除只读工具用仓库根实测):循环执行工具并回灌→end_turn 收口、抛错工具转 is_error 且循环继续、步数上限中止、只读工具读根内成功且拒绝逃逸/未知工具、`parseModelResponse` 解析 text+tool_use+stop_reason、`createAnthropicCallModel` 落到 `/v1/messages` 并解析回复。
- 端点路由玻璃(装机后实测):鉴权 + 校验 + 活跃节点解析。

## 后续(内核路线)
- 下一片:流式事件 + 交互式运行卡(选根目录 + 提问 + 转写),再加写/执行工具(带确认),最终把内核注册为第 6 家 provider;并在过程里持续 UI 化繁为简。

## 下载校验
- DMG SHA-256:`f27738aca8e5a52b1f78012abc0d5787317d6f09a55cf08d7c16f3bc77f3c7be`
- ZIP SHA-256:`7cc57c067dc7aa5e0678dd561e7140565a969bf2829d418ed927119706964cf8`
- `latest-mac.yml` SHA-256:`514d6012e781482b91ae6dd12530b7ddf5220e7e2d20f88057cc144e1b132d19`

> 注:本版 DMG 未做窗口背景美化(本机 Finder 自动化权限被系统重置,-1743),纯功能包,不影响安装/签名/公证/热更新。
