/**
 * 订阅模块级 SSH host registry 快照。首次加载期间返回空数组且不展示 loading;
 * 项目身份解析会继续使用 session.remoteHostId,拿到 registry 后再原位刷新。
 */

import { useEffect, useState } from 'react';

import { remoteSshHostsStore } from '@/lib/remoteSshHostsStore';

export function useRemoteSshHosts(): readonly RemoteHostSnapshot[] {
  const [hosts, setHosts] = useState<readonly RemoteHostSnapshot[]>(
    () => remoteSshHostsStore.get() ?? [],
  );

  useEffect(() => {
    const cached = remoteSshHostsStore.get();
    if (cached !== null) setHosts(cached);

    const unsubscribe = remoteSshHostsStore.subscribe(() => {
      setHosts(remoteSshHostsStore.get() ?? []);
    });
    if (remoteSshHostsStore.get() === null) {
      void remoteSshHostsStore.ensure().catch(() => {
        // SSH config 不可读时保持 remoteHostId 兜底;下次 remount 可再次尝试。
      });
    }
    return unsubscribe;
  }, []);

  return hosts;
}
