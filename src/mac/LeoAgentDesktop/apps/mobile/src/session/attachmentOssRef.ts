/** Mobile 兼容入口；附件引用契约的唯一实现位于 @cindy/device-link。 */
export {
  ATTACH_OSS_SCHEME,
  buildAttachmentOssRef,
  buildLegacyAttachmentOssRef,
  isAttachmentOssRef,
  isValidAttachmentIntegrity,
  LEGACY_ATTACH_OSS_SCHEME,
  parseAttachmentOssRef,
} from '@cindy/device-link';
export type { AttachmentIntegrity, AttachmentOssRef } from '@cindy/device-link';
