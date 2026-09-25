# FoundationModels（iOS / watchOS 27）技术验证结论

日期：2026-09-25 · 依据：本机 Xcode 27 SDK 的 `FoundationModels.swiftinterface` 与 `.swiftdoc`（未在真机上调用，原因见下）。

## 27 新增了什么

| 能力 | SDK 里的样子 | 说明 |
|---|---|---|
| 自定义模型接入 | `protocol LanguageModel`（`capabilities`、`executorConfiguration`）+ `protocol LanguageModelExecutor`（`init(configuration:)`、`prewarm(model:transcript:)`、`respond(to:model:streamingInto:)`） | 第三方模型可以包成系统的 `LanguageModelSession` 后端。流式事件经 `LanguageModelExecutorGenerationChannel` 发出：`.response`、`.reasoning`、`.toolCalls` |
| 执行请求 | `LanguageModelExecutorGenerationRequest`：`transcript`、`enabledToolDefinitions`、`schema`、`generationOptions`、`contextOptions`、`metadata` | 会话、工具、结构化输出都由系统会话管理 |
| 苹果私有云模型 | `final class PrivateCloudComputeLanguageModel`：`availability`（`deviceNotEligible` / `systemNotReady`）、`quotaUsage`（`status`、`resetDate`、`isLimitReached`） | 用法是一行：`LanguageModelSession(model: PrivateCloudComputeLanguageModel())`。**需要受管权限**：文档原话是开发 PCC 必须满足资格要求，并向苹果申请 managed entitlement |
| 手表 | 同一套 API 在 watchOS 27 可用；端侧 `SystemLanguageModel` 在手表上不可用 | 手表只能用自定义执行器或私有云模型 |

## 放到 LeoPhoneAgent 里看

1. **自定义执行器（把现有服务商包成 `LanguageModel`）**：收益小，暂不做。
   - Agent 循环自己已经实现了流式、工具调用、上下文压缩、多服务商回落和审批。
   - 包一层系统会话，等于把这些再交给系统管一遍。两套会话状态要对齐，调试面翻倍。
   - 唯一值得的场景是手表：手表直连模型那段代码可以改用系统会话，和 iPhone 共用工具定义。但手表当前只做问答、不跑工具，现在的 `WatchStandaloneClient`（HTTPS 请求 / 响应 + 后台续传）已经够用。
2. **私有云模型做标题和摘要**：值得做，但卡在权限上。
   - 标题、会话摘要、压缩前的小结这类短任务，现在花的是用户自己服务商的 token。换成私有云模型可以免费、隐私更好，也更快。
   - 前提是拿到受管权限。个人开发者账号能否申请到未知；拿不到时代码里 `availability` 会一直是不可用。
   - 模拟器和没有权限的签名都无法真实调用，所以这次没有写产品代码，只留结论。

## 建议的下一步

1. 用开发者账号在 developer.apple.com/private-cloud-compute 申请权限。
2. 拿到后只加一个很小的接入点：`TitleAndSummaryModel` 在 iOS 27 且 `PrivateCloudComputeLanguageModel().isAvailable` 时优先走它，`quotaUsage.isLimitReached` 或出错时回落到当前的「标题模型槽」。
3. 自定义执行器等手表要跑工具时再评估，不预先搭。
