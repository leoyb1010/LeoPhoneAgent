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
    version: '1.69.0',
    date: '2026-08-18',
    items: [
      '额度改成问官方要,不再靠猜:此前是被动扫本机日志尾部、等服务端偶然下发的额度帧(可能是几小时前的旧数字),现在用本机已有的登录态直接调官方接口拿当前额度。Codex 与 Claude Code 已打通,面板上标「权威」。',
      '菜单栏额度面板按 CodexBar 的设计重做:每个额度窗口一行「标题 + 剩余百分比 + 重置倒计时 + 进度条 + 配速」,进度条上还画出配速位置与 50%/20% 警戒刻度。',
      '新增配速判断:告诉你「按当前速度用得完用不完」——超前多少、还能撑多久、预计几点用光、有多大风险,而不只是一个干巴巴的百分比。',
      '读不到就明说读不到:Gemini、Cursor、Grok、OpenCode 各自写清楚缺哪一样凭据,不再是笼统的「未接入」,更不会填 0 或编一个百分比冒充额度。',
      '本机日志统计降级为接口失败时的兜底,并明确标注「本机统计」,不会再和权威额度混在一起看不出区别。',
      '发版更新提示加了自动闸门:版本号与更新说明对不上就直接构建失败 —— 1.68.0 那次漏写、装上却弹不出更新的情况,以后不会再发生。',
    ],
  },
  {
    version: '1.68.0',
    date: '2026-08-18',
    items: [
      '对话即首页:去掉 9 项侧边导航与仪表盘首页,冷启动直接落在会话上,新任务只走一个悬浮指挥条。',
      '菜单栏新增 AI 额度面板:⏲ 图标 + 计量条 + 百分比,点开是本机 AI 用量总览,只读各家 CLI 已落在本机的状态,不登录任何一家服务。',
      '额度数字严格区分权威与估算:服务端下发的真实额度窗口标「权威」,本机日志统计标「本机统计」,读不到就显示「读不到」,不填 0、不编百分比。',
      '会话列表本机与远程同列,meta 标机器名;Fleet 收进标题栏远程胶囊,快速任务与项目树收进 ⌘K。',
      '停在旧的仪表盘 / Fleet / 快速任务页面的安装,会一次性迁移到对话页。',
      '设置栏目一个没减,只重新归组:外观移入「工作区」,插件移入「系统」。',
    ],
  },
  {
    version: '1.67.1',
    date: '2026-08-11',
    items: [
      '修复 Mac 首页设置按钮无效：设置弹窗从项目侧栏提升为全局宿主，现在首页、三台 Mac 和项目工作区都能可靠打开。',
      '首页刷新升级为真实完成态：等待全部关键接口返回，显示刷新中、已更新或刷新失败，并阻止重复提交。',
      '两个首页控制改为带文字的明确按钮，并补充键盘、读屏语义与交互回归测试，避免再次退化成无反馈图标。',
    ],
  },
  {
    version: '1.67.0',
    date: '2026-08-11',
    items: [
      '正式并入 LeoPhoneAgent 主仓：iPhone、iPad、Mac 工作台和中继服务从此使用同一份源码历史；更新分发仓只保存安装资产。',
      'Mac 首页重做为单一任务控制层：一个开始入口、一个跨 Mac 入口，加上真实健康、Agent、项目与今日会话状态；删掉重复路线卡和卡中卡。',
      '设置中心升级为 LeoPhoneAgent · Mac 品牌框架：分组搜索、当前区域提示、紧凑导航、统一层级和更清晰的进入/按压反馈。',
      'Ponytail 瘦身：移除 102 MB 未被构建引用的原始设计图、4 个闲置发布依赖及 1,756 行传递锁文件，不删任何产品能力。',
      '更新源与源码职责分离：源码、问题与主页指向 LeoPhoneAgent；签名安装资产继续从 leocodebox-updates 获取。',
    ],
  },
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
  const exact = LEO_RELEASE_NOTES.find((n) => n.version === version);
  if (exact) return exact;
  if (!version) return LEO_RELEASE_NOTES[0] ?? null;
  // 当前版本漏了条目。绝不能拿上一版内容顶上——那样弹卡看着正常,内容却是
  // 上一版的,"漏写"被伪装成"已写",下次照漏(1.68.0 就是这么漏过去的)。
  // 宁可把缺失摆在脸上:弹照弹(铁律要求每次发版都弹),但明说这版没写。
  return {
    version,
    date: '',
    items: [`本版本(${version})的更新说明缺失 —— 发版时漏了 LEO_RELEASE_NOTES 条目,请补上。`],
  };
}
