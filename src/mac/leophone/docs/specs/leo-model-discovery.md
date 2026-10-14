# 从接口获取模型(Model Discovery)

设置 → 模型供应商。以前添加模型只能逐个手敲 ID,各家写法不同(`claude-opus-5-5` / `gpt-5.5`)经常敲错;
新建自定义供应商默认 Anthropic 格式,而第三方中转大多是 OpenAI 兼容;本机 Ollama / LM Studio 不填 Key 进不了 Registry。

## 状态所有者与接口

- 唯一入口:`IProviderSettingsService.discoverModels(input)`(`ServiceChannels.ProviderSettings`,RPC 自动代理,
  远程 workspace 走远端 Host)。请求/响应类型与运行时校验在 `@zcode/shared/model-discovery`。
- 输入 `{ providerId }`:Base URL、格式、Key、自定义头、内置模型都由 Host 从**已保存**的 Effective Config 解析,
  Key 不经 Renderer 往返。草稿场景可传 `{ baseUrl, apiFormat, apiKey?, templateId? }`。
- 输出 `{ models: [{ id, displayName, contextWindow?, maxOutput?, capabilities?, releaseDate?, hidden? }], source, error? }`,
  `source ∈ endpoint | catalog | builtin`,`error.kind ∈ auth | not_supported | network | tls | unknown`。
- 发现结果只是 UI 局部状态,不落盘;用户确认后逐个调用既有 `addPersonalModel(..., useRecommendedConfig=true)`
  (同一 Provider 串行写,避免并发 add 互相覆盖成员列表)。不会自动删除模型。

```
Renderer (ProviderModelsSection)          Host (ProviderSettingsService)            网络
  点「从接口获取模型」/自动触发
  ├─ commitPendingDraft(连接草稿落盘) ─▶ savePersonalProviderOverlay
  └─ discoverModels({providerId}) ───────▶ waitForProviderOperations(providerId)
                                           resolve baseUrl/format/key(已保存配置)
                                           GET …/models(Host 代理感知 transport,10s)──▶ 供应商
                                           models.dev 目录(24h 缓存,失败用旧缓存)──▶ models.dev
                               ◀────────── { models, source, error? }
  选择 → addPersonalModel × N(串行) ────▶ 写 personal config → onDidChange 刷新 View
```

## 列模型规则

- OpenAI 两种格式:`GET {base}/models`,有 Key 才带 `Authorization: Bearer`;base 不以 `/v1` 结尾且 404 时重试 `{base}/v1/models`。
- Anthropic:`GET {normalizeAnthropicBaseURL(base)}/models?limit=1000`,`x-api-key` + `anthropic-version: 2023-06-01`,
  非 `api.anthropic.com` 另带 Bearer;按 `has_more` / `last_id` 翻页(最多 10 页)。404 / HTML / 非 JSON 时再试 `{origin}/v1/models`(Bearer)。
- 供应商自定义 headers 一并发送,同名时用户配置优先(与运行时一致)。
- 401/403 → `auth`,不回退。404 / 405 / HTML / JSON 解析失败 / 空列表 → 回退模板内置列表(`builtin`),
  没有内置列表再按 Base URL 匹配 models.dev(`catalog`),`error.kind = not_supported`。
  网络 / TLS / 其他 HTTP 错误照实报告,有内置列表时一并带回。
- 嵌入、TTS、Whisper/转写、生图、审核等非对话模型标记 `hidden`,UI 默认不显示,可「显示全部」。

## 展示名与能力

- models.dev(`https://models.dev/api.json`)缓存到 `~/.leophoneagent/v2/cache/models-dev-api.json`,最多 24 小时联网一次,
  失败后 10 分钟内不重试并沿用旧缓存。按完整 ID 查,再去掉 `vendor/` 前缀查;同 ID 多家时第一方优先。
- 无目录条目时用 `prettifyModelId` 兜底(纯函数,有单测):`claude-opus-5-5 → Claude Opus 5.5`、
  `claude-haiku-4-5-20251001 → Claude Haiku 4.5`、`gpt-5.5 → GPT-5.5`;已含大写的 ID 原样保留。
- 模型选择器对 API Key 供应商显示美化名,原始 ID 作悬停提示;账号套餐模型不变。存储与请求始终用原始 ID。

## UI

- 模型列表标题旁:主按钮「从接口获取模型」(未填 Base URL 时禁用)+ 原「添加模型」。
- 自动获取:已保存 Base URL 且(有 Key 或本机免 Key 地址)且零模型时,每个 `providerId|baseUrl` 每次启动只跑一次,
  列出了模型才弹出选择框。
- 选择框:搜索、按系列分组、每行 32px(勾选、展示名、等宽 ID、视觉/推理/上下文徽标);已添加的勾选并禁用;
  默认勾选每个系列最新 2 个(按 release_date,否则按版本号;同展示名只取一个),最多 10 个;全选/取消;
  `auth` 时提示并标红 API Key 输入框;`not_supported` 显示「已使用内置列表」横幅;网络 / TLS 显示原因与重试。
  已有模型时显示「新增 N / 已下线 N」,已下线的只提示,由用户手动删除。

## 默认接口格式

- 无模板新建的自定义供应商在创建时显式写入 `api.type = openai-chat-completions`(`DEFAULT_CUSTOM_PROVIDER_API_TYPE`)。
- 运行时不对缺失的 `api.type` 做兜底:完整 schema 要求 `type`,缺失即不进 Registry。旧版本 UI 在用户首次填写
  Base URL 时就会把当时显示的格式写入配置,因此已可用的供应商都带显式 `type`,不受影响。UI 对缺失值的展示默认同步改为
  OpenAI 兼容,与新建默认一致。

## 免 Key 端点

- `access.type = api-key` + `api.type = openai-chat-completions` + Base URL 主机为 `localhost` / `127.x` / `::1` / `0.0.0.0` / `*.local`
  时,`apiKey` 不再是准入必填项。运行时 openai-compatible 在没有 Key 时本就不带 Authorization 头;
  Anthropic / OpenAI Responses SDK 缺 Key 会直接报错,所以不豁免。远端地址仍要求填写 Key。

## 验收

- `node --import tsx --test packages/shared/src/model-discovery.test.ts`
- `node --import tsx --test packages/services/test/providerModelDiscovery.test.ts packages/services/test/providerCustomDefaults.test.ts`
