import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '../../utils/apiClient';
import { startVisibleInterval } from '../../utils/visibilityInterval';

export type FleetSession = {
  session_id: string;
  harness: string;
  status: string;
  cwd: string;
  waiting_for_approval?: boolean;
};

export type FleetMachine = {
  name: string;
  online: boolean;
  reachable: boolean;
  platform?: string;
  server?: string;
  version?: string;
  activeCount: number;
  sessions: FleetSession[];
};

export function isMinisBody(machine: FleetMachine | undefined): boolean {
  return machine?.platform === 'android' || machine?.platform === 'harmony' || machine?.server === 'minis';
}

export function harnessForMachine(machine: FleetMachine | undefined, selected: string): string {
  return isMinisBody(machine) ? 'minis' : selected;
}

/** 指挥条 / 主控台开远程任务时的字段。minis 身体不吃 Mac 本地 cwd。 */
export function remoteLaunchFields(
  machine: FleetMachine | undefined,
  selected: string,
  extras: { cwd?: string; thinking?: string } = {},
): { harness: string; cwd?: string; thinking?: string } {
  const harness = harnessForMachine(machine, selected);
  const thinking = extras.thinking && extras.thinking !== 'default' ? extras.thinking : undefined;
  return harness === 'minis'
    ? { harness, thinking }
    : { harness, cwd: extras.cwd, thinking };
}

type FleetPayload = {
  configured?: boolean;
  localName?: string;
  machines?: FleetMachine[];
};

const POLL_MS = 15_000;

/**
 * 舰队快照 —— 标题栏「远程 · N 台在线」胶囊与指挥条的 @目标 都读它。
 *
 * Fleet 从独立 Tab 降级成一个弹层后,这份数据不再属于某个页面,所以
 * 提到 hook 里由外壳持有。轮询遵守 GUIDELINES 第 5 条:窗口不可见时暂停。
 */
export function useFleetSnapshot() {
  const [machines, setMachines] = useState<FleetMachine[]>([]);
  const [localName, setLocalName] = useState<string>('');
  const [configured, setConfigured] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const payload = await apiClient.get<FleetPayload>('/api/leophone/fleet');
      setConfigured(payload.configured !== false);
      if (typeof payload.localName === 'string' && payload.localName) setLocalName(payload.localName);
      setMachines(Array.isArray(payload.machines) ? payload.machines : []);
    } catch {
      // 中继不可达时保留上一次快照,标题栏胶囊不闪。
    }
  }, []);

  useEffect(() => {
    void refresh();
    return startVisibleInterval(() => void refresh(), POLL_MS);
  }, [refresh]);

  // 本机自己也在中继里注册,远程列表要把它剔掉。
  const remotes = machines.filter((machine) => machine.name !== localName);
  const onlineCount = remotes.filter((machine) => machine.online).length;

  return { remotes, onlineCount, localName, configured, refresh };
}
