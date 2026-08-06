import { useEffect, useState } from 'react';

import { useControllableDevices } from './useControllableDevices';

function hasReadyRemoteHost(hosts: readonly RemoteHostSnapshot[]): boolean {
  return hosts.some((host) => host.status === 'ready');
}

export function useHasAnyReadyRemoteHost(): boolean {
  const [hasAny, setHasAny] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await window.electronAPI.remoteSsh.list();
        if (!cancelled) setHasAny(hasReadyRemoteHost(res.hosts));
      } catch {
        if (!cancelled) setHasAny(false);
      }
    };
    void refresh();
    const off = window.electronAPI.remoteSsh.onStatusChanged(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return hasAny;
}

/**
 * 「添加远程项目」入口的统一 gate:有 ready SSH 主机 **或** 有可控被控设备时显示。
 * device-link 接入后,SSH 与同账号设备统一进同一个「添加远程项目」流程。
 */
export function useHasAnyRemoteTarget(): boolean {
  const hasReadySsh = useHasAnyReadyRemoteHost();
  const devices = useControllableDevices();
  return hasReadySsh || devices.length > 0;
}
