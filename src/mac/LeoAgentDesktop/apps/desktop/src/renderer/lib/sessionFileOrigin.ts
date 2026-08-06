/**
 * sessionFileOrigin.ts — 会话「文件来源」统一抽象。
 * ---------------------------------------------------------------------------
 * 一个会话引用的文件 / 媒体字节实际位于哪台机器,决定聊天流里所有文件类交互
 * (图片渲染、TextLightbox 预览、打开 / 定位文件、右键菜单)该走哪条管线:
 *
 *   - local  → 本机文件系统,直接用绝对路径操作(现状行为)。
 *   - device → device-link 被控端(跨设备镜像会话),字节经 OSS 中转取回
 *              (见 shared/remoteMediaUrl.ts + main/device-link/remoteMediaProtocol.ts)。
 *   - ssh    → SSH 远端 host(Codex remote 会话),字节经 remote-file-service
 *              分片拉取落本地磁盘缓存(见 main/file-browser/)。
 *
 * 两个远程维度互斥:device-link 的 deviceId 只存在于内存镜像(remoteProjectsStore),
 * SSH 的 remoteHostId 落库在 session 行;一个会话不会同时具备两者。判定优先级与
 * workdir-browse(WorkdirBrowseRoute)保持一致:deviceId 优先,其次 remoteHostId。
 *
 * 本模块是纯类型 + 纯函数,不依赖 React / store,可直接单测。渲染侧取值入口见
 * components/chat/ChatSessionFileContext.tsx。
 */

import type { RemoteMediaOrigin } from '../../shared/remoteMediaUrl';

/** 会话文件来源判别联合。 */
export type SessionFileOrigin =
  | { kind: 'local' }
  | { kind: 'device'; deviceId: string }
  | { kind: 'ssh'; remoteHostId: string };

/** 本地来源单例(默认值 / 非会话场景复用,避免每次新建对象打破 memo 相等性)。 */
export const LOCAL_FILE_ORIGIN: SessionFileOrigin = Object.freeze({ kind: 'local' });

/** 该来源是否远程(device-link 或 SSH)——远程时禁止直接拿绝对路径打本机文件系统。 */
export function isRemoteFileOrigin(
  origin: SessionFileOrigin,
): origin is Exclude<SessionFileOrigin, { kind: 'local' }> {
  return origin.kind !== 'local';
}

/** 取 device-link deviceId(非 device 来源 → undefined);兼容只认 deviceId 的旧调用面。 */
export function originDeviceId(origin: SessionFileOrigin): string | undefined {
  return origin.kind === 'device' ? origin.deviceId : undefined;
}

/**
 * 会话文件来源 → 远程媒体 URL 来源(shared/remoteMediaUrl 的判别单元)。
 * local → undefined(不改写);ssh 必须携带会话 workdir(main handler 无状态
 * 算 relPath 用),workdir 缺失时按不可改写处理(返回 undefined 而不是造出
 * 一个取不到字节的 token)。
 */
export function toRemoteMediaOrigin(
  origin: SessionFileOrigin,
  workingDir: string,
): RemoteMediaOrigin | undefined {
  if (origin.kind === 'device') return { kind: 'device', deviceId: origin.deviceId };
  if (origin.kind === 'ssh' && workingDir) {
    return { kind: 'ssh', remoteHostId: origin.remoteHostId, workdir: workingDir };
  }
  return undefined;
}

/**
 * 由两个远程维度字段合成来源。deviceId 优先于 remoteHostId(与 workdir-browse
 * 的判定一致);两者皆空 → local 单例。
 */
export function resolveSessionFileOrigin(
  deviceId: string | undefined,
  remoteHostId: string | null | undefined,
): SessionFileOrigin {
  if (deviceId) return { kind: 'device', deviceId };
  if (remoteHostId) return { kind: 'ssh', remoteHostId };
  return LOCAL_FILE_ORIGIN;
}
