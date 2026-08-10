/**
 * [T-release-notes] 随包内置的更新记录。
 *
 * 为什么不复用现有的 VersionUpgradeModal:那个读的是 GitHub Release,
 * 只有正式发布过的版本才有内容 —— 内部迭代装上去以后一片空白,等于
 * "更新了但不知道更新了什么"。这份清单跟着代码走,发版即生效,
 * 与 LeoPhoneAgent 的机制同构(那边是 LeoReleaseNotes.all)。
 *
 * 发版铁律:每次改动装到机器上,都要在最前面加一条。
 */

export type LeoReleaseNote = {
  version: string;
  date: string;
  items: string[];
};

export const LEO_RELEASE_NOTES: LeoReleaseNote[] = [
  {
    version: '1.64.0',
    date: '2026-08-10',
    items: [
      '舰队视图:在任意一台 Mac 上看见另外两台的运行情况,不必逐台去开',
      '审批中心:全舰队待审批聚到一处,最近的排最前,当场放行或拒绝',
      '更新记录随包内置:以后每次更新都会在启动时弹一次「本次更新」,不再依赖 GitHub 发布',
      '界面转向简约:减少装饰性图标与色块,信息密度优先',
      '设置页分组 + 搜索:13 项平铺改为智能体/工作区/系统三组,顶部可搜',
    ],
  },
  {
    version: '1.63.0',
    date: '2026-08-09',
    items: [
      '接管 LeoPhoneAgent 的 Mac 端:harness 协议 + 自营中继客户端',
      '新增会话摘要、任务收据、产物下载三个接口',
      '关键事件主动外推到中继,手机不在线也不丢审批请求',
    ],
  },
];

const SEEN_KEY = 'leo.releaseNotes.lastSeenVersion';

export function currentAppVersion(): string {
  // Vite 在构建时注入;取不到就当作未知,不弹卡(宁可不弹,不要误弹)
  return (import.meta.env?.VITE_APP_VERSION as string) || '';
}

/** 版本变了返回 true。看完才记账,所以这里不写入。 */
export function shouldShowWhatsNew(): boolean {
  const version = currentAppVersion();
  if (!version) return false;
  try {
    return localStorage.getItem(SEEN_KEY) !== version;
  } catch {
    return false;
  }
}

export function markWhatsNewSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, currentAppVersion());
  } catch {
    // 隐私模式下写不了,不影响功能
  }
}

export function currentReleaseNote(): LeoReleaseNote | null {
  const version = currentAppVersion();
  return LEO_RELEASE_NOTES.find((n) => n.version === version) ?? LEO_RELEASE_NOTES[0] ?? null;
}
