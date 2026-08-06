/**
 * remoteSessionExit.test.ts —— 远程会话 origin 消失时的退回决策(纯函数)。
 * 锁住核心修复:本机 relay 瞬时重连不把用户踢出当前远程会话(让 RemoteSessionBanner「重连中」可见)。
 */
import { describe, it, expect } from 'vitest';

import { decideRemoteSessionExit } from '@/features/cc-agent/remoteSessionExit';

describe('decideRemoteSessionExit', () => {
  it('仍有 origin → 不退回', () => {
    expect(
      decideRemoteSessionExit({ hasOrigin: true, wasRemote: true, reconnecting: false, deviceStillOnline: true }),
    ).toEqual({ exit: false, toastOffline: false });
  });

  it('从来不是远程会话 → 不退回(本机会话不受影响)', () => {
    expect(
      decideRemoteSessionExit({ hasOrigin: false, wasRemote: false, reconnecting: false, deviceStillOnline: false }),
    ).toEqual({ exit: false, toastOffline: false });
  });

  it('[核心] 本机 relay 瞬时重连 → 不退回(保留视图,banner 显示重连中),即便镜像已清', () => {
    // origin 没了 + 设备分片也空了(clear 所致),但 reconnecting=true → 必须留住,不能踢人/误报离线。
    expect(
      decideRemoteSessionExit({ hasOrigin: false, wasRemote: true, reconnecting: true, deviceStillOnline: false }),
    ).toEqual({ exit: false, toastOffline: false });
  });

  it('relay 在线 + 会话被删/归档(设备分片仍在)→ 静默退回(不提示离线)', () => {
    expect(
      decideRemoteSessionExit({ hasOrigin: false, wasRemote: true, reconnecting: false, deviceStillOnline: true }),
    ).toEqual({ exit: true, toastOffline: false });
  });

  it('relay 在线 + 设备掉线/关被控(整片移除)→ 退回并提示离线', () => {
    expect(
      decideRemoteSessionExit({ hasOrigin: false, wasRemote: true, reconnecting: false, deviceStillOnline: false }),
    ).toEqual({ exit: true, toastOffline: true });
  });
});
