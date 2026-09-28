import { z } from "zod";

/** 设备目录只传元数据；网络地址里的凭据不能随着目录复制给其他端。 */
const httpsEndpoint = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        Boolean(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "Expected an HTTPS endpoint without credentials, query or fragment");

export const leoDeviceEndpointSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(["direct", "relay"]),
  baseURL: httpsEndpoint,
  expiresAt: z.number().int().nonnegative().optional(),
});

/** 接受描述符只代表格式有效；调用方仍须通过配对和握手验证设备身份。 */
export const leoDeviceDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: z.uuid(),
  name: z.string().min(1).max(128),
  platform: z.string().min(1).max(32),
  capabilities: z.array(z.string().min(1).max(64)).max(64),
  endpoints: z
    .array(leoDeviceEndpointSchema)
    .max(8)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      "Endpoint IDs must be unique",
    ),
  aliases: z.array(z.string().min(1).max(128)).max(16).optional(),
});

export type LeoDeviceEndpoint = z.infer<typeof leoDeviceEndpointSchema>;
export type LeoDeviceDescriptor = z.infer<typeof leoDeviceDescriptorSchema>;
