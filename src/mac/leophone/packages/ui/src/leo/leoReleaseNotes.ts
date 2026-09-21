/**
 * [leo][T-release-notes] LeoPhoneAgent Mac 的「本次更新」。
 *
 * 发版铁律:每次发版都必须在这张表最前面加一条,版本号等于根 package.json 的
 * version,内容就是这一版真正改了什么。scripts/leo-verify-release-notes.mjs
 * 挂在打包链首 —— 漏写就打不出包,不靠人记。
 */
export interface LeoRelease {
  version: string;
  date: string;
  items: string[];
}

export const LEO_RELEASE_NOTES: LeoRelease[] = [
  {
    version: "1.0.1",
    date: "2026-09-21",
    items: [
      "彻底独立:不再连接 ZCode / Z.ai / 智谱的任何服务器。更新只走 LeoPhoneAgent 自己的更新源,官方的强制升级提示已移除;帮助配置、灰度配置、插件市场远端分片、官方 CDN、遥测全部停用;网络层另加一道兜底,所有官方域名一律拦截,漏网的调用也发不出去。",
      "不接入任何官方账号:移除 Z.ai / BigModel 登录和 Coding Plan 订阅、购买入口;不再读取官方客户端 ~/.zcode 下的配置、账号和会话,agent 与各子进程的数据统一放在 ~/.leophoneagent。",
      "新增订阅账号登录:Claude(Pro / Max)、ChatGPT(Plus / Pro)、GitHub Copilot,以及 Kimi、xAI、OpenRouter,在浏览器里授权即可使用。登录后模型自动出现在「订阅账号」供应商下,凭据只保存在本机。入口在欢迎页和设置里的模型供应商。",
      "会话分享与导入依赖官方服务器,已关闭。SSH / Docker 远程工作区的远端运行时原本从官方 CDN 下载,这一版暂不可用,之后改由我们自己的更新源提供。",
    ],
  },
  {
    version: "1.0.0",
    date: "2026-09-21",
    items: [
      "LeoPhoneAgent Mac 1.0:内核基于 ZCode(zai-org/ZCode,Apache-2.0)重做成我们自己的产品。会话工作台、工具时间线、Git 面板、文件树与搜索、终端、内嵌浏览器与 Browser Use、插件商店、MCP、技能、Hooks、斜杠命令、定时任务与闲时任务、记忆、会话分享与导入、SSH / WSL / Docker 远程工作区,全部可用。",
      "权限四档 plan / build / ask / yolo,按会话切换;模型用 API key 接入 Anthropic、OpenAI、OpenAI 兼容端点与任意自定义供应商,智谱账号是可选项不是前提。",
      "完全本地、完全独立:数据存在 ~/.leophoneagent,和官方 ZCode 客户端各存各的,不会读到它的账号;不向 Z.ai 上报遥测、崩溃与性能数据;不需要任何平台账号,填 API key 即可开工。",
      "藏宝阁和 Telegram 通道保留:藏宝阁以 MCP 工具(treasury_search / get / save / update)接入任意会话;Telegram 配对后可在聊天里开会话、审批与收结果。",
      "旧版 2.2.x 的会话不迁移(格式不同),需要翻旧记录时打开保留的 leocodebox 2.2 即可。手机远程控制这一版暂停,下一轮对齐。",
    ],
  },
];

const SEEN_KEY = "leo.releaseNotes.lastSeenVersion";

export function currentLeoRelease(version: string): LeoRelease | null {
  return LEO_RELEASE_NOTES.find((entry) => entry.version === version) ?? null;
}

/** 版本变了、且这一版确实写了条目才弹。看完才记账,所以这里不写入。 */
export function shouldShowLeoWhatsNew(version: string): boolean {
  if (!version || version.startsWith("0.0.0")) return false;
  if (!currentLeoRelease(version)) return false;
  try {
    return localStorage.getItem(SEEN_KEY) !== version;
  } catch {
    return false;
  }
}

export function markLeoWhatsNewSeen(version: string): void {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    // 隐私模式下写不了,下次再弹,不影响功能
  }
}
