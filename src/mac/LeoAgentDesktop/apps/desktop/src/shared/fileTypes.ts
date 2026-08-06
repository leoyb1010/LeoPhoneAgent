/**
 * 自有文件格式的 MIME 类型(未经 IANA 注册,按惯例 x- 前缀 + xd 厂商段)。
 *
 * 注册落点:Windows 注册表 Content Type(main/cindy-brain/fileAssociation.ts)、
 * macOS UTI 声明(forge.config.ts 的 UTExportedTypeDeclarations,构建配置
 * 不 import 本文件,字面量需与此保持一致)。注册后 OS 拖拽进 Chromium 时
 * DataTransferItem.type 会带上这些值,renderer 得以在 drop 前(拿不到文件名
 * 的 dragover 阶段)识别文件类型并给出针对性遮罩。
 *
 * ⚠️ 仅打包构建注册;dev 环境 / 未装过新版的机器上拖拽 type 为空字符串,
 * 消费方必须容忍识别失败(降级为 drop 后按扩展名判定的既有链路)。
 */
export const CINDY_MIME_TYPE = 'application/x-xd-cindy';
export const SHARE_MIME_TYPE = 'application/x-xd-cshare';

/** 意识安装包扩展名(拖入 / 双击装入判定,统一小写比较)。 */
export const CINDY_FILE_EXT = '.cindy';
/** 会话分享文件扩展名(现行 .cshare + 旧 .xdtshare,内容格式相同)。 */
export const SHARE_FILE_EXTS = ['.cshare', '.xdtshare'] as const;
