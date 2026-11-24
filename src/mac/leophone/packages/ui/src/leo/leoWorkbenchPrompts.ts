export const LEO_WORKBENCH_STARTERS = [
  {
    id: "html",
    title: "HTML 简报",
    en: "HTML brief",
    description: "生成、预览与修改",
    enDescription: "Build, preview and refine",
    prompt:
      "生成单文件 HTML 简报，不引用外部资源。检查交互并交付真实可运行文件。简报主题是：",
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
