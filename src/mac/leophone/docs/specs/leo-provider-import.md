# 从 iPhone 导入服务商

设置 → 模型供应商 →「从 iPhone 导入」。把 LeoBot iOS 的服务商配置搬到 Mac,不必重新逐个填写地址和模型。

## 为什么走导出文件

iPhone → Mac 同步副本(`packages/desktop/src/host/leo/sync`,`ProviderInstanceV3`)**不带 API Key**
(`secretBlob` 恒为空,Key 只走 iCloud 钥匙串)。可靠来源是 iOS 自己的导出 JSON
(`src/ios/Providers/ProviderConfigStore.swift` `exportInstanceJSON`),用户隔空投送到 Mac。

**注意**:iOS 界面上的导出入口(服务商详情页右上角分享按钮,无障碍标签「导出配置（不含密钥）」)
调用 `exportInstanceJSON(id)`,默认 `includeSecrets=false`,文件里 `secretsOmitted: true`、没有 `apiKey`。
所以实际导入后通常需要在 Mac 上补填 Key;只有调试导出(`includeSecrets: true`)或旧版明文导出才带 Key。
iOS 的整机备份(`Agent/Backup`)是加密归档,不是服务商列表格式,不支持。

## 所有者与流程

```
Renderer                                   Host (ProviderSettingsService.importProviders)
  <input type=file accept=.json multiple>
  File.text()(>2MB 的文件不读,直接标无效)
  importProviders({files:[{name,content}]}) ─▶ zod 校验(≤20 个文件、每个 ≤2MB)
                                              解析 → 映射 → 去重决定(同一批内顺序生效)
                                              createPersonalProvider / savePersonalProviderOverlay
                                              / addPersonalModel(串行,与界面新建同一路径)
                         ◀──────────────────  { items: [{status, reason?, needsKey, modelCount, providerId?}] }
  结果列表;needsKey 的供应商打开时 Key 输入框标红
```

- 原始 JSON 只在 Host 内存中处理,不落盘;结果与日志都不含 Key(Renderer 日志只记文件个数)。
- 单项失败只影响该项;总计最多 100 个服务商,每个最多 1000 个模型。

## 格式

单个对象、对象数组,或 `{ "providers": [...] }`。字段:`providerType`、`label`、`credentialType`(`apiKey` / `oauth`)、
`models[]`(`modelId`、`isHidden`、`contextWindow`、`maxOutputTokens`、`modalityOverride` 位掩码、`overrides{…}`)、
`apiKey` / `manualOAuthToken`(base64(utf8),不是合法 base64 可打印文本时按明文)、`customBaseURL`、
`appendV1Suffix`(缺省 true)、`customUserAgent`、`azureMode`、`secretsOmitted`。未知字段忽略。

## 映射

| iOS providerType | Mac 接口格式 | Base URL |
|---|---|---|
| openAI | openai-chat-completions | customBaseURL 或 `https://api.openai.com`;`appendV1Suffix !== false` 时去掉尾部 `/v1` 再补一个 `/v1` |
| openAIResponses | openai-responses | 同上 |
| anthropic | anthropic-messages | customBaseURL 或 `https://api.anthropic.com`(运行时自动补 /v1) |
| openRouter | openai-chat-completions | customBaseURL 或 `https://openrouter.ai/api/v1` |
| xAI | openai-chat-completions | customBaseURL 或 `https://api.x.ai/v1` |
| gemini | openai-chat-completions | `https://generativelanguage.googleapis.com/v1beta/openai`(Mac 无 Gemini 原生协议) |
| kimiCode | openai-chat-completions | (customBaseURL 或 `https://api.kimi.com/coding`)+ `/v1` |

- 跳过并给原因:`openCodeGo`(Mac 用订阅账号)、`credentialType=oauth` 且没有 Key / 手动 token(OpenRouter 除外)、
  `azureMode=true`、未知类型、非 http(s) 地址、无效文件。
- Key:`apiKey` 优先,其次 `manualOAuthToken` 作为 Bearer Key。没有 Key 仍导入供应商和模型,`needsKey=true`;
  本机地址(localhost / 127.x / ::1 / *.local)免 Key。
- `customUserAgent` → 供应商自定义头 `User-Agent`。`isEnabled` 不迁移(导入后均为启用)。
- 模型:跳过 `isHidden`;按智能配置(`useRecommendedConfig=true`)添加,上下文 / 最大输出取 `overrides ?? 基础值`,
  `modalityOverride & 4`(imageInput)映射图片输入。Mac 不存显示名,列表用 `prettifyModelId` 美化。
- 导入后零模型时,打开该供应商且已有 Key(或本机免 Key)会自动触发「从接口获取模型」(见 `leo-model-discovery.md`)。

## 去重

同名(trim)且同 Base URL(去尾斜杠、忽略大小写)的现有非账号供应商 → **更新**:合并缺少的模型;文件带 Key 且与现有不同才覆盖 Key。
否则新建,名称冲突时追加 ` (2)`、` (3)`……(与 iOS 一致)。重复导入同一文件不会产生重复供应商。

## 验收

`node --import tsx --test packages/services/test/iosProviderImport.test.ts`
