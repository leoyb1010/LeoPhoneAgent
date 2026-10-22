/**
 * [leo] LeoBot 自带的定时任务模板:Mac 自动化页「从模板开始」(packages/ui settings)和
 * 手机 `GET /automations/templates`(docs/specs/leo-link-automations.md)共用这一份,不各存一套。
 * 计划一律是 Mac 编辑器能显示和编辑的 5 段 cron(本机时区)。
 */
export interface LeoAutomationTemplateText {
  cn: string;
  en: string;
}

export interface LeoAutomationTemplate {
  id: string;
  /** 桌面模板卡片的图标名(AutomationScheduledTemplateIcon)。 */
  icon: "target" | "activity" | "file";
  cronExpr: string;
  /** 手机建这条时建议的权限模式(plan = 只读不问;guarded = 自主,危险命令才问)。 */
  mode: "plan" | "guarded";
  title: LeoAutomationTemplateText;
  description: LeoAutomationTemplateText;
  prompt: LeoAutomationTemplateText;
}

export const LEO_AUTOMATION_TEMPLATES: readonly LeoAutomationTemplate[] = [
  {
    id: "leo-daily-brief",
    icon: "target",
    cronExpr: "0 9 * * *",
    mode: "plan",
    title: { cn: "每日早报", en: "Daily brief" },
    description: {
      cn: "每天早上结合第二大脑和这个项目昨天的进展，列出今天要做的 3–5 件事。",
      en: "Every morning, combine your second brain with yesterday's progress in this project and list 3–5 things to do today.",
    },
    prompt: {
      cn: [
        "生成今天的早报。",
        "1. 第二大脑：先调用 leo-brain 的 brain_brief，再用 brain_search 查今天和昨天的日报页（daily page）、最近 3 天新增的知识卡（kind=card），需要细节时用 brain_read 读原文。leo-brain 不可用就跳过这一步，并在早报里说一句。",
        "2. 这个项目：看昨天的提交和任务，列出完成了什么、哪些失败或卡住（附原因）。",
        "3. 只读：不改文件，不调用 brain_save_card / brain_upload，不读日历、邮件等需要系统授权的应用。",
        "输出：结论先行，15 行以内；最后用「今天要做」列 3–5 条，每条一句话、能直接动手，标明来自哪里（第二大脑 / 项目）。",
      ].join("\n"),
      en: [
        "Write today's morning brief.",
        "1. Second brain: call leo-brain's brain_brief first, then brain_search for today's and yesterday's daily page and the knowledge cards added in the last 3 days (kind=card); use brain_read when you need the source text. If leo-brain is unavailable, skip this step and say so in the brief.",
        "2. This project: look at yesterday's commits and tasks — what finished, what failed or stalled (with the reason).",
        "3. Read-only: do not change files, do not call brain_save_card / brain_upload, and do not read Calendar, Mail or other apps that need system permission.",
        "Output: lead with the conclusion, 15 lines max; end with 'Today' — 3–5 one-line items you can act on right away, each tagged with where it came from (second brain / project).",
      ].join("\n"),
    },
  },
  {
    id: "leo-repo-health",
    icon: "activity",
    cronExpr: "0 18 * * 1-5",
    mode: "guarded",
    title: { cn: "下班前跑一遍测试", en: "End-of-day test run" },
    description: {
      cn: "工作日 18:00 拉取最新代码并跑测试，失败时说明原因。",
      en: "On weekdays at 18:00, pull the latest code and run the tests; explain any failure.",
    },
    prompt: {
      cn: "拉取当前分支最新代码，运行项目的测试命令。全部通过就回复一句「测试全绿」；有失败时列出失败用例、错误原文和最可能的原因，不要改代码。",
      en: "Pull the latest code on the current branch and run the project's tests. If everything passes, reply 'All green'. Otherwise list the failing tests, the exact errors and the most likely cause. Do not change code.",
    },
  },
  {
    id: "leo-weekly-review",
    icon: "file",
    cronExpr: "0 20 * * 0",
    mode: "plan",
    title: { cn: "每周回顾", en: "Weekly review" },
    description: {
      cn: "周日晚上把这周的改动整理成一页回顾。",
      en: "Sunday evening, turn this week's changes into a one-page review.",
    },
    prompt: {
      cn: "整理这个项目本周的提交和完成的任务，写一页回顾：做成了什么、还有什么没收尾、下周建议先做什么。用大白话，不超过 20 行。",
      en: "Go through this week's commits and finished tasks in this project and write a one-page review: what shipped, what is still open, and what to do first next week. Plain language, 20 lines max.",
    },
  },
];
