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
    version: "1.2.2",
    date: "2026-09-25",
    items: [
      "手机能看到 Mac 上开的任务了:最近打开的项目里的任务会出现在手机的任务列表中;在手机上点开或接着发消息,这台 Mac 就把它接过来,之后流式进度、审批、停止都和手机开的任务一样。之前的对话留在 Mac 上,手机从接上那一刻开始同步。",
    ],
  },
  {
    version: "1.2.1",
    date: "2026-09-25",
    items: [
      "手机连 Mac 更快:这台 Mac 开着代理(比如 Clash)时,和中继之间的常驻连接改走 Tailscale 内网直连,每次来回从两三秒降到几十毫秒;没开 Tailscale 时照旧走原来的路。",
      "「完全访问」模式下,创建、保存、修改工作流也不再询问,Mac 上自己开的任务和手机发来的全自动任务一样;被禁用的工具、项目里设为拒绝的规则照样拦住,计划模式照样要问。",
    ],
  },
  {
    version: "1.2.0",
    date: "2026-09-25",
    items: [
      "手机重新连回 Mac:iPhone 经自己的中继直接在这台 Mac 上开 LeoPhoneAgent 任务,看流式输出、审批、停止。审批三种答法:允许一次、本次会话允许(只对这个任务里同一个命令或文件生效,不写成项目规则)、拒绝;在 Mac 上答了,手机上的卡片也会收起。",
      "断线不丢:每条事件都编号并写进本机日志,手机断网、锁屏后回来按序号续传,不丢不重;Mac 重启后,手机上已有的任务照样能续看、续聊、审批。手机暂时答不了的提问会自动跳过并说明,任务不会卡住。",
      "手机只看到这一台 Mac:原来的 Claude Code、Codex、Grok 会话照常可用(由本机 leoagent 继续跑),和 LeoPhoneAgent 任务出现在同一个列表里。经中继只开放手机要用的接口,模型代理、藏宝阁和机器人配置一律不对外。",
      "为手机「全自动」做好准备:只接受已配对 iPhone 的请求,旧版设备和旧钥匙发来的一律拒绝;中继升级到 0.2、手机换上设备钥匙后生效。",
      "聊天机器人遥控改用内置的机器人服务(设置里配置,默认关闭),自建的 Telegram 通道下线。机器人开的任务改为「先问我」:聊天里只能批准读文件和改工作区内的文件,执行命令、联网、MCP、工作流只能拒绝,要做就回 iPhone 或 Mac 上批。",
      "本机接口的钥匙比对改为常数时间。",
    ],
  },
  {
    version: "1.1.0",
    date: "2026-09-24",
    items: [
      "同步上游 ZCode v3.14.3:动态工作流(多 agent 编排)更稳,运行中可调参数,运行面板和进度时间线重做,草稿修改不再反复询问。",
      "新增聊天机器人遥控的配置界面(Telegram、飞书、微信、Webhook),默认全部关闭,不配置就不会连接任何平台;原有的 Telegram 通道这一版不变,下一版切到这套机器人。",
      "保持独立:同步进来的新文案和机器人回复里的 ZCode 字样都改成 LeoPhoneAgent,安装包信息里不再写官方网址和邮箱。",
    ],
  },
  {
    version: "1.0.1",
    date: "2026-09-21",
    items: [
      "彻底独立:不再连接 ZCode / Z.ai / 智谱的任何服务器。更新只走 LeoPhoneAgent 自己的更新源,官方强制升级提示已移除;官方远程开关(灰度、帮助配置、自动化模板)、插件市场远端分片、官方 CDN、遥测全部停用;网络层另加一道兜底,主进程、窗口进程和 agent 进程都会拦下所有官方域名。",
      "不接入任何官方账号:移除 Z.ai / BigModel 登录、Coding Plan 订阅与购买、账号头像与用量菜单,欢迎页也不再要智谱 API Key。不再读取官方客户端 ~/.zcode 下的任何内容:设置、MCP、技能、命令、Hooks、AGENTS.md、会话库和日志统一放在 ~/.leophoneagent;链接协议改为 leophoneagent://,不再和官方客户端抢。",
      "新增订阅账号登录:Claude(Pro / Max)、ChatGPT(Plus / Pro)、GitHub Copilot,以及 Kimi、xAI、OpenRouter,在浏览器里授权即可使用,模型自动出现在「订阅账号」供应商下,凭据只保存在本机。授权失效会提示重新登录,额度用完或服务繁忙会自动重试,上下文超长会自动压缩。入口在欢迎页和 设置 → 模型供应商。",
      "动态工作流(多 agent 编排)原本由官方服务器灰度开放,现在本地默认开启。闲时任务依赖官方套餐,已隐藏。",
      "去掉依赖官方服务的入口:帮助菜单里的官方文档、社区与反馈,各处反馈按钮,会话分享与导入;插件商店只保留随包插件,「更新日志」改为打开我们自己的发布页。SSH / Docker 远程工作区的远端运行时原本从官方 CDN 下载,这一版暂不可用。",
      "品牌统一:启动动画、会话背景水印、关于窗口和安装包背景都换成 LeoPhoneAgent 的标志与名字,不再出现 ZCode 的 Z。",
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
