# leo-eval：Agent 编码能力评测

用 8 个自包含的小任务，经 headless CLI（`zcode -p … --output-format stream-json`）跑真实 agent 循环，
统计通过率、token（含缓存命中）、各工具调用次数、Edit 失败次数与 Edit 入参形态（单段 / 多段 `edits[]` / hashline 锚点）。
用来比较模型、编辑格式（replace / hashline）、精简档等档位的效果。

## 快速开始

```bash
cd src/mac/leophone

# 1) 不花钱的 dry-run：本地 mock 模型按脚本回放解题步骤，验证整条链路（每个任务跑 replace 与 hashline 两档）
node scripts/leo-eval/run-eval.mjs --dry-run --dev

# 2) 真实模型：自己准备 models.json（见下），API Key 放环境变量
node scripts/leo-eval/run-eval.mjs --models scripts/leo-eval/models.example.json   # 先复制一份改成自己的
```

- `--dev`：用源码入口 `apps/zcode-cli/packages/cli/src/main.ts`（tsx）。其余 workspace 包从各自 `dist/` 加载，
  改过 contracts / core / adapters / bootstrap 后先在对应包里 `npx tsc -p .` 构建。
- 默认（不带 `--dev`）用打好的 `apps/zcode-cli/packages/cli/dist/zcode.cjs`；`--cli <path>` 指定别的 CLI。
- `--tasks rename-function,large-file` 只跑部分任务；`--timeout 600` 单任务超时秒数（默认 900）；
  `--keep-repos` 保留临时仓库便于排查；`--out <file>` 结果 JSON 路径（默认 `scripts/leo-eval/results/`，已 gitignore）。
- `--leo-agent '<json>'`：给这次运行注入 Leo 档位（与 `~/.leophoneagent/cli/config.json` 的 `"leo"` 段同结构），
  例如 `'{"hashlineFamilies":true}'`(GLM / Kimi / MiniMax 走 hashline,默认关)、`'{"editMode":{"default":"hashline"}}'`、
  `'{"leanProfile":true}'`、`'{"readLineNumbers":false}'`。
  models.json 里单个模型也可以写 `"leo": {…}`。

退出码：全部通过为 0，否则 1。

## models.json

```json
[
  {
    "name": "kimi-k2 (hashline)",
    "providerId": "moonshot",
    "modelId": "kimi-k2-0905-preview",
    "api": { "type": "openai-chat-completions", "baseUrl": "https://api.moonshot.cn/v1", "apiKeyEnv": "MOONSHOT_API_KEY" },
    "leo": { "hashlineFamilies": true }
  },
  {
    "name": "kimi-k2 replace (default)",
    "providerId": "moonshot",
    "modelId": "kimi-k2-0905-preview",
    "api": { "type": "openai-chat-completions", "baseUrl": "https://api.moonshot.cn/v1", "apiKeyEnv": "MOONSHOT_API_KEY" },
    "leo": { "editMode": { "models": { "*": "replace" } } }
  }
]
```

`api.type` 可为 `openai-chat-completions` / `openai-responses` / `anthropic-messages`；`reasoningLevel` 可选（默认 `disabled`）。
不要把 key 写进文件，用 `apiKeyEnv` 指向环境变量。注意独立性红线：不要把任何 `*.z.ai / bigmodel.cn / zhipuai.cn / zcode.ai`
端点写进来（agent 进程的网络兜底也会拦下）。

## 隔离

每个任务一个临时目录：`repo/`（git 仓库）、`home/`（作为 `HOME` / `ZCODE_DATA_BASE_DIR` / `ZCODE_STORAGE_DIR`）、
`provider_config.json`（经 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 指定）。不读写你本机的 `~/.leophoneagent`，
子进程只拿到 `PATH` / `LANG` / `TMPDIR` 等最小环境。检查脚本写在仓库外，agent 看不到也改不到。
CLI 以 `--mode yolo` 运行（headless 下没人批准权限请求）。

## 结果字段

每条结果：`passed`、`exitCode`、`durationMs`、`usage`（`inputTokens` / `outputTokens` / `cacheReadTokens` /
`cacheWriteTokens` / `modelRequests`）、`tools`（按工具名计数）、`editFailures` 与前几条失败信息、
`editShapes`（`single` / `multi` / `anchored`）、`check`（失败时的检查输出尾部）。
每次 Edit 命中的匹配策略另见 agent 日志里 `tool.call.completed` 的 `editMatchStrategies` 字段。

## 任务

| id | 考察点 |
|---|---|
| rename-function | 同一文件多处改名（多段 `edits[]`） |
| fix-off-by-one | 按失败测试修 bug；mock 脚本故意先错一次，验证失败计数 |
| crlf-config | CRLF 文件改两个值，行尾不能被改成 LF |
| smart-quotes-doc | 文件用弯引号与破折号，模型写直引号（窄归一化匹配） |
| add-function | 新增并导出函数，测试 + 隐藏断言 |
| large-file | 3000 行文件深处定点修改（范围读取 / hashline 锚点） |
| json-config | 结构化改 package.json |
| bom-csv | UTF-8 BOM 文件编辑并追加一行，BOM 必须保留 |

加任务：在 `tasks.mjs` 里追加一项（`files`、`prompt`、`check`、`mock`）。`check` 是一段 ES module 源码，
在仓库目录执行，抛错即失败；`mock` 是 dry-run 时 mock 模型按顺序回放的工具调用。

## mock 模型

`mock-model-server.mjs` 是只监听 127.0.0.1 的 OpenAI 兼容服务（流式 / 非流式都支持），
按请求头 `x-leo-eval-task` 找到任务、按已有 tool 结果数决定下一步。hashline 档下它会把整行替换改写成
`{op:"replace", pos:"行号#哈希", lines:[…]}`，锚点取自最近一次 Read 的输出，从而端到端覆盖 hashline。
设 `LEO_EVAL_MOCK_LOG=<file>` 可记录每个请求的工具列表、系统提示长度、是否带 `prompt_cache_key`。
也可单独启动：`node scripts/leo-eval/mock-model-server.mjs 8787`。
