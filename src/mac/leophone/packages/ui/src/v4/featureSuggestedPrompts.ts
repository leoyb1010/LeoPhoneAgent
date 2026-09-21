/* eslint-disable max-lines -- 推荐语料按表格逐条维护，集中放置便于对照审核。 */
import finderIcon from "@/onboarding/assets/finder.png";
import terminalIcon from "@/onboarding/assets/terminal.png";
import documentsIcon from "@/assets/plugin-icons/documents.png";
import pdfIcon from "@/assets/plugin-icons/pdf.png";
import presentationsIcon from "@/assets/plugin-icons/presentations.png";
import spreadsheetsIcon from "@/assets/plugin-icons/spreadsheets.png";
import type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

// [leo] 上游这里还有一批推荐条目，图标取自官方插件 CDN 素材（远程图片），
// LeoPhoneAgent 不连官方 CDN，这些条目整体移除；只保留使用本地图标的推荐。

type FeatureRecommendedPrompt = DraftSuggestedPromptItem & {
  mode: "office" | "coding";
};

// 本期推荐按模式硬分池；展示文案和填入正文分别维护。
export const featureSuggestedPrompts: FeatureRecommendedPrompt[] = [
  {
    id: "feature-recvvsPdvcWQzF",
    mode: "office",
    iconUrl: terminalIcon,
    label: {
      cn: "帮我看看电脑空间主要被什么占满了",
      en: "Show what is using up space on my computer",
    },
    prompt: {
      cn: "帮我分析这台电脑的磁盘占用情况，找出占空间最多的目录和大文件，区分系统文件、应用数据与个人文件。告诉我哪些可以考虑清理、预计能释放多少空间；先不要删除任何文件。",
      en: "Analyze disk usage on this computer. Identify the largest directories and files, distinguish system files, application data, and personal files, and estimate what I could safely clean up. Do not delete any files.",
    },
  },
  {
    id: "feature-recvvsPdvcUwzl",
    mode: "office",
    iconUrl: presentationsIcon,
    iconStyle: "plugin",
    label: {
      cn: "生成一份可以直接分享的演示文稿",
      en: "Create a presentation I can share",
    },
    prompt: {
      cn: "请使用 [@演示文档](plugin://presentations@zcode-plugins-official) 帮我围绕 [主题] 做一份可以直接分享的演示文稿。先用公开资料补齐背景，形成清晰的核心观点和叙事结构，再生成带标题、关键结论和来源的幻灯片。不要编造事实，未确定的内容请标注。",
      en: "Use [@Presentations](plugin://presentations@zcode-plugins-official) to create a shareable presentation about [topic]. Research public background, develop a clear argument and narrative, and produce slides with titles, conclusions, and sources. Label uncertain claims instead of inventing facts.",
    },
    plugin: {
      stableId: "presentations@zcode-plugins-official",
      label: { cn: "演示文档", en: "Presentations" },
    },
  },
  {
    id: "feature-recvvsPdvcPqQQ",
    mode: "office",
    iconUrl: finderIcon,
    label: {
      cn: "帮我看看这台电脑的下载文件夹应该如何整理一下？",
      en: "Find what I should clean up in Downloads",
    },
    prompt: {
      cn: "帮我看看这台电脑下载文件夹里有哪些大量重复文件、旧安装包和明显的临时文件，按预计可释放空间排序，并给出整理建议。先不要移动或删除文件。",
      en: "Inspect this computer’s Downloads folder for duplicates, old installers, and obvious temporary files. Rank the opportunities by space they could free and suggest an organization plan. Do not move or delete anything yet.",
    },
  },
  {
    id: "feature-recvvsPdvcgq6k",
    mode: "office",
    iconUrl: pdfIcon,
    iconStyle: "plugin",
    label: {
      cn: "生成一份有来源的主题研究 PDF 报告",
      en: "Create a sourced PDF research report on a topic",
    },
    prompt: {
      cn: "请使用 [@PDF](plugin://pdf@zcode-plugins-official)，围绕 [调研主题] 生成一份可以分享的 PDF 研究报告。先查找近期公开可信的资料，再整理背景、关键事实、不同观点和仍待验证的问题；重要数字标明时间与来源，文末附参考链接。缺少可靠依据的内容请明确标注，不要编造。",
      en: "Use [@PDF](plugin://pdf@zcode-plugins-official) to create a shareable PDF research report on [research topic]. Find recent credible public sources, then cover the background, key facts, differing views, and open questions. Date and source important figures and include references. Mark claims without reliable evidence instead of inventing them.",
    },
    plugin: {
      stableId: "pdf@zcode-plugins-official",
      label: { cn: "PDF", en: "PDF" },
    },
  },
  {
    id: "feature-recvvsPdvcsDgI",
    mode: "office",
    iconUrl: documentsIcon,
    iconStyle: "plugin",
    label: {
      cn: "生成一份可编辑的项目方案文档",
      en: "Create an editable project proposal",
    },
    prompt: {
      cn: "请使用 [@Word文档](plugin://documents@zcode-plugins-official)，围绕 [项目主题] 生成一份可编辑的 Word 项目方案。写清目标用户与问题、方案选择、主要工作、里程碑、风险和待确认事项。缺少业务背景时先采用明确标注的合理假设，并在文末列出最需要我补充的三项信息；不要编造内部数据。",
      en: "Use [@Documents](plugin://documents@zcode-plugins-official) to create an editable Word proposal for [project topic]. Cover users and their problem, options, work plan, milestones, risks, and open decisions. When business context is missing, label reasonable assumptions and list the three most useful details for me to add. Do not invent internal data.",
    },
    plugin: {
      stableId: "documents@zcode-plugins-official",
      label: { cn: "Word文档", en: "Documents" },
    },
  },
  {
    id: "feature-recvvsPdvcSvEZ",
    mode: "office",
    iconUrl: spreadsheetsIcon,
    iconStyle: "plugin",
    label: {
      cn: "生成一份可以直接使用的月度收支表",
      en: "Create a ready-to-use monthly income and expense tracker",
    },
    prompt: {
      cn: "请使用 [@电子表格](plugin://spreadsheets@zcode-plugins-official) 生成一份可以直接开始记账的 Excel 月度收支表。每条记录能填写日期、收支类型、分类、金额和备注；提供常用分类、按月和分类自动汇总，以及收入、支出和结余。放几条明确标为示例的数据让我看懂怎么填，正式汇总不要把示例计入真实收支。无需先问我收入或消费明细。",
      en: "Use [@Spreadsheets](plugin://spreadsheets@zcode-plugins-official) to create an editable Excel monthly income and expense tracker I can start using right away. Let each entry capture its date, income or expense type, category, amount, and note. Include common categories and automatic monthly and category totals, including income, expenses, and balance. Add a few clearly marked example entries to show how it works, but exclude them from real totals. Do not ask for my financial details before creating the template.",
    },
    plugin: {
      stableId: "spreadsheets@zcode-plugins-official",
      label: { cn: "电子表格", en: "Spreadsheets" },
    },
  },
  {
    id: "feature-recvvsPdvcK0EZ",
    mode: "office",
    iconUrl: terminalIcon,
    label: {
      cn: "看看我的电脑最近为什么变慢了",
      en: "Find out why my computer feels slow",
    },
    prompt: {
      cn: "帮我检查这台电脑当前的资源占用，找出可能让它变慢的进程和磁盘、内存压力。区分眼下可观察到的事实和可能原因，并告诉我可以先做哪几件安全的事。不要结束进程或改系统设置。",
      en: "Check current resource use on this computer and identify processes, disk pressure, or memory pressure that may explain why it feels slow. Separate what you can observe from possible causes, and suggest safe first steps. Do not terminate processes or change system settings.",
    },
  },
  {
    id: "feature-coding-repo-start",
    mode: "coding",
    iconUrl: terminalIcon,
    label: {
      cn: "帮我看懂并运行当前仓库",
      en: "Help me understand and run this repository",
    },
    prompt: {
      cn: "帮我快速了解当前打开的仓库是做什么的、主要功能在哪里，以及在这台电脑上怎样启动它。请实际尝试运行一个最核心的流程，最后给我一份简明上手说明，标出关键文件、运行结果和遇到的阻碍；如果当前没有打开仓库，先让我选择一个。",
      en: "Help me understand what the open repository does, where its main features live, and how to run it on this computer. Try one core workflow, then give me a concise guide with key files, what ran successfully, and any blockers. If no repository is open, ask me to select one.",
    },
  },
  {
    id: "feature-coding-check-failures",
    mode: "coding",
    iconUrl: terminalIcon,
    label: {
      cn: "帮我运行项目现有检查并定位失败",
      en: "Run the existing checks and diagnose failures",
    },
    prompt: {
      cn: "帮我检查当前仓库现有的代码检查和测试能否通过。请优先运行项目已经配置、在当前环境可执行的检查；如果失败，定位最可能的原因，区分本分支引入的问题和原有问题，并给我可执行的修复建议。不要把没运行的检查写成通过，也先不要大范围改代码。",
      en: "Check whether the open repository’s existing code checks and tests pass. Run the checks already configured and feasible in this environment. For failures, identify likely causes, separate issues introduced by this branch from existing ones, and suggest actionable fixes. Do not call unrun checks passes or make broad code changes yet.",
    },
  },
  {
    id: "feature-coding-dependencies",
    mode: "coding",
    iconUrl: terminalIcon,
    label: {
      cn: "帮我检查仓库的依赖和升级风险",
      en: "Review this repository’s dependencies and upgrade risks",
    },
    prompt: {
      cn: "帮我检查当前仓库的主要依赖，找出已经过时、存在明确安全风险或阻碍后续升级的部分。结合项目实际使用情况，按优先级给我一份清单，说明影响、证据和建议的升级顺序；不要仅凭版本旧就判定有问题，也先不要批量升级。",
      en: "Review the open repository’s main dependencies for outdated packages, confirmed security risks, and likely upgrade blockers. Consider how this project actually uses them, then give me a prioritized list with impact, evidence, and a suggested upgrade order. Do not treat age alone as a defect or upgrade everything yet.",
    },
  },
];

export function getRecommendedPromptPool(isOfficeMode: boolean): DraftSuggestedPromptItem[] {
  const mode = isOfficeMode ? "office" : "coding";
  return featureSuggestedPrompts.filter((item) => item.mode === mode);
}
