/**
 * remoteSessionExit —— 远程会话「origin 从镜像消失时是否退回 /cc-agent」的纯决策。
 * ---------------------------------------------------------------------------
 * 从 CCAgentSessionView 抽出便于单测:打开的 device-link 远程会话,其 sessionId→deviceId origin
 * 从 remoteProjectsStore 消失时,要区分消失来因再决定去留(否则本机 relay 瞬时重连也会把用户
 * 踢出对话 + 误报「设备离线」,且 RemoteSessionBanner「重连中」状态形同虚设)。
 */

export interface RemoteSessionExitParams {
  /** store 里仍有该会话的 origin(sessionId→deviceId 仍在)。 */
  hasOrigin: boolean;
  /** 本会话曾被确认是远程会话(用于排除从来就是本机的会话)。 */
  wasRemote: boolean;
  /** 本机到 relay 的链路正在瞬时重连(linkStatus != online)。 */
  reconnecting: boolean;
  /** 最后已知的被控设备此刻是否仍在镜像里(整片移除=掉线/关被控)。 */
  deviceStillOnline: boolean;
}

export interface RemoteSessionExitDecision {
  /** 是否退回 /cc-agent。 */
  exit: boolean;
  /** 退回时是否提示「远程设备已离线」(仅设备整片移除时)。 */
  toastOffline: boolean;
}

/**
 * 决策表:
 *  - 仍有 origin / 从来不是远程会话 → 不退回。
 *  - 本机 relay 瞬时重连(origin 是断链 clear() 清掉的,被控端没真没)→ **不退回**(保留视图,
 *    让 banner 显示「重连中」,等 relay 回 online 再判)。
 *  - relay 在线但 origin 仍没了(真没了)→ 退回;设备整片移除(deviceStillOnline=false)才提示离线。
 */
export function decideRemoteSessionExit(p: RemoteSessionExitParams): RemoteSessionExitDecision {
  if (p.hasOrigin || !p.wasRemote) return { exit: false, toastOffline: false };
  if (p.reconnecting) return { exit: false, toastOffline: false };
  return { exit: true, toastOffline: !p.deviceStillOnline };
}
