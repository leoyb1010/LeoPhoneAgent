/** 远程项目在 UI 中显示的机器身份,统一供项目树、搜索与筛选使用。 */
export interface RemoteProjectMachineIdentity {
  kind: 'ssh' | 'device-link';
  /** 主要身份:SSH alias、设备名,或无法解析时的持久化 id。 */
  label: string;
  /** 补充身份:user@hostname[:port] 或设备 id。 */
  detail: string | null;
  /** 适合 tooltip / 紧凑元信息行的完整单行文案。 */
  displayLabel: string;
}

interface RemoteProjectIdentitySource {
  scope: 'local' | 'remote';
  remoteHostId: string | null;
  deviceLinkDeviceId: string | null;
  deviceLinkDeviceName: string | null;
  remoteMachineIdentity?: RemoteProjectMachineIdentity | null;
}

function joinIdentity(label: string, detail: string | null): string {
  return detail ? `${label} · ${detail}` : label;
}

/** 把项目持久化身份与当前 SSH registry 合并成稳定、可读的展示模型。 */
export function resolveRemoteProjectMachineIdentity(
  project: Omit<RemoteProjectIdentitySource, 'remoteMachineIdentity'>,
  sshHosts: readonly RemoteHostSnapshot[],
): RemoteProjectMachineIdentity | null {
  if (project.scope !== 'remote') return null;

  if (project.deviceLinkDeviceId) {
    const name = project.deviceLinkDeviceName?.trim() || project.deviceLinkDeviceId;
    const detail = name === project.deviceLinkDeviceId ? null : project.deviceLinkDeviceId;
    return {
      kind: 'device-link',
      label: name,
      detail,
      displayLabel: joinIdentity(name, detail),
    };
  }

  if (!project.remoteHostId) return null;
  const host = sshHosts.find((candidate) => candidate.config.id === project.remoteHostId);
  if (!host) {
    return {
      kind: 'ssh',
      label: project.remoteHostId,
      detail: null,
      displayLabel: project.remoteHostId,
    };
  }

  const endpoint = `${host.config.user}@${host.config.hostname}${
    host.config.port === 22 ? '' : `:${host.config.port}`
  }`;
  return {
    kind: 'ssh',
    label: host.config.id,
    detail: endpoint,
    displayLabel: joinIdentity(host.config.id, endpoint),
  };
}

/** 已富化的 ProjectNode 优先;测试/旧调用方未富化时仍按持久化 id 兜底。 */
export function getRemoteProjectMachineIdentity(
  project: RemoteProjectIdentitySource,
): RemoteProjectMachineIdentity | null {
  if (project.remoteMachineIdentity !== undefined) return project.remoteMachineIdentity;
  return resolveRemoteProjectMachineIdentity(project, []);
}

/** 需要把项目名序列化到搜索请求/ARIA 文案时使用,避免同路径远程项目同名。 */
export function projectDisplayLabelWithMachine(
  project: RemoteProjectIdentitySource & { displayName: string },
): string {
  const identity = getRemoteProjectMachineIdentity(project);
  return identity ? `${project.displayName} (${identity.displayLabel})` : project.displayName;
}
