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
    version: '1.66.1',
    date: '2026-08-10',
    items: [
      '手机收藏镜像认识「笔记」了:纯笔记条目带标识显示,不再是一行没有链接的孤零零文字',
      '批注跟着显示:手机上给收藏写的想法,这里能看到,也能被搜索命中',
      '手机上归档的条目这里同步收起 —— 两端看到的是同一个库',
    ],
  },
  {
    version: '1.66.0',
    date: '2026-08-10',
    items: [
      '关于页大扫除:去掉全部装饰图,直接从版本信息开始;更新记录改读随包内置数据(原来读 GitHub Release,内部版本永远是空的)',
      '通知设置:开启后的「关闭通知」按钮原来是红底红字(完全看不清,像一块莫名的红框),改为普通描边按钮',
      '舰队页:后台标签不再空转轮询;上一轮请求没回来不叠发;手机收藏跟随同一节拍刷新,不再冻结在进入页面那一刻',
    ],
  },
  {
    version: '1.65.1',
    date: '2026-08-10',
    items: [
      '中文化清扫:侧栏导出、置顶等提示改为中文;把散落在代码里的 166 条中文文案归入语言包(此前它们只活在兜底值里,翻译文件是空的)',
    ],
  },
  {
    version: '1.65.0',
    date: '2026-08-10',
    items: [
      '手机收藏在 Mac 上可查:手机把收藏索引同步到中继,这里只读展示并可搜(附件与正文留在手机里,不复制出来)',
      '舰队页整合:机器状态、待审批、手机收藏三块并列在同一页',
    ],
  },
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
