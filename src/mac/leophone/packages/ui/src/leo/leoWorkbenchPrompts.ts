export const LEO_WORKBENCH_STARTERS = [
  {
    id: "html",
    title: "编程与 HTML",
    en: "Code & HTML",
    description: "生成、预览与修改",
    enDescription: "Build, preview and refine",
    prompt:
      "制作一个高级、简约的交互式 HTML 单文件页面，CSS/JS全部内联，不引用外部URL（CDN、字体、图片）；图片用内联SVG或data URI。先明确内容和交互，输出真实可运行文件；检查桌面与窄屏、按钮和页面错误，再给出可预览、可下载的结果。",
  },
  {
    id: "code",
    title: "修改代码",
    en: "Improve code",
    description: "理解项目，修改并验证",
    enDescription: "Understand, change and verify",
    prompt:
      "检查当前项目，帮我完成代码修改。先阅读项目规则与相关实现，保留已有改动；展示关键变更，并实际运行相关测试或构建。我的具体目标是：",
  },
  {
    id: "research",
    title: "研究与交付",
    en: "Research & deliver",
    description: "资料整理与多格式交付",
    enDescription: "Turn sources into useful work",
    prompt:
      "根据我提供的资料完成研究，区分事实与推断并保留来源，整理成清晰的报告；按需要输出 HTML、Markdown 或结构化数据文件。研究主题是：",
  },
] as const;

/** 使用编辑器当前内容合并，不回放点击时保存的旧草稿。 */
export function appendLeoDraftPrompt(current: string, addition: string): string {
  if (!addition.trim() || current.includes(addition)) return current;
  return current.trim() ? `${current}\n\n${addition}` : addition;
}

/** 旧入口只填新任务；文件追改显式绑定目标会话，后台/其他会话不能消费。 */
export function canApplyLeoComposerInsert(
  request: { targetSessionId?: string | null } | null | undefined,
  sessionId: string | null,
  focused: boolean,
): boolean {
  return Boolean(focused && request && (request.targetSessionId ?? null) === sessionId);
}
