/**
 * [leo] 「从 iPhone 导入服务商」的 RPC 协议。
 *
 * iPhone → Mac 的同步副本不带 API Key(钥匙只走 iCloud 钥匙串),所以导入走 iOS 自己的
 * 「导出服务商」JSON:用户把文件隔空投送到 Mac,Renderer 读出文本交给 Host 解析。
 * 解析、映射与写入全部在 Host 完成;这里只放边界类型与上限。
 */
import { z } from "zod";

export const PROVIDER_IMPORT_LIMITS = {
  maxFiles: 20,
  /** 单个文件上限 2MB(按 UTF-16 字符数近似,iOS 导出是纯 ASCII/UTF-8 JSON)。 */
  maxFileChars: 2 * 1024 * 1024,
  maxProviders: 100,
  maxModelsPerProvider: 1000,
} as const;

export const providerImportRequestSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            name: z.string().max(512),
            content: z.string().max(PROVIDER_IMPORT_LIMITS.maxFileChars),
          })
          .strict(),
      )
      .min(1)
      .max(PROVIDER_IMPORT_LIMITS.maxFiles),
  })
  .strict();
export type ProviderImportRequest = z.infer<typeof providerImportRequestSchema>;

export const providerImportSkipReasonSchema = z.enum([
  /** 文件不是合法 JSON / 不是 iOS 导出格式 */
  "invalid-file",
  /** 超过单次导入的服务商数量上限 */
  "too-many",
  /** Mac 不认识的 providerType */
  "unsupported-type",
  /** OpenCode Go:Mac 走「订阅账号」 */
  "opencode-go",
  /** 只有登录态(ChatGPT / xAI / Kimi 登录),导出文件里没有可用的 Key */
  "oauth-only",
  /** Azure 模式暂不支持 */
  "azure",
  /** Base URL 不是合法的 http(s) 地址 */
  "invalid-base-url",
  /** 写入配置时失败 */
  "failed",
]);
export type ProviderImportSkipReason = z.infer<typeof providerImportSkipReasonSchema>;

export const providerImportItemResultSchema = z
  .object({
    fileName: z.string(),
    label: z.string(),
    providerType: z.string(),
    status: z.enum(["imported", "updated", "skipped"]),
    reason: providerImportSkipReasonSchema.optional(),
    /** 失败细节(不含任何凭据)。 */
    detail: z.string().optional(),
    providerId: z.string().optional(),
    /** 导入后仍没有 Key(导出时未含密钥),需要在 Mac 上补填。本机免 Key 地址为 false。 */
    needsKey: z.boolean(),
    /** 本次新加入的模型数。 */
    modelCount: z.number().int().nonnegative(),
  })
  .strict();
export type ProviderImportItemResult = z.infer<typeof providerImportItemResultSchema>;

export const providerImportResultSchema = z
  .object({ items: z.array(providerImportItemResultSchema) })
  .strict();
export type ProviderImportResult = z.infer<typeof providerImportResultSchema>;
