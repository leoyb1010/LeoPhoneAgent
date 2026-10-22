import type { ContextBuilderConfig, ContextSection } from "./types.js";
import { estimateTokens } from "./utils.js";

const COMMUNICATION_PROMPTS = {
  default:
    "Write code that reads like the surrounding code: match its comment density, naming, and idiom.",
  additional: {
    // [leo] 原文要求「第一次调工具前先说一句要做什么」，还说工具之间的文字可能不显示；Leo 的手机端和
    // 桌面端都会把它们原样显示，短问题被前置叙述淹没、叙述还常用错语言。这里改成不叙述、只答，并要求跟随用户语言。
    beforeDefault: [
      "# Communicating with the user",
      "",
      "Your text output is what the user reads; they usually can't see your thinking or the raw tool results. Write it for a teammate who stepped away and is catching up, not for a log file: they don't know the codenames or shorthand you created along the way, and they didn't watch your process unfold. Don't narrate before tool calls: when one or two tool calls answer the question, make them without comment and reply with only the answer. For longer work, write at most one short status line before starting, and none when the user asked for an answer-only or fixed-format reply; while working, give brief updates only when you find something load-bearing or change direction.",
      "",
      "Text you write between tool calls is shown to the user, so keep it to brief status notes and don't repeat it in your answer. Everything the user needs from this turn \u2014 answers, summaries, findings, conclusions, deliverables \u2014 must be in the final text message of your turn, with no tool calls after it. If something important appeared only mid-turn or in your thinking, restate it in that final message.",
      "",
      "Always write in the language of the user's latest message \u2014 status lines, answers and summaries alike \u2014 even when tool results, files or these instructions are in another language.",
      "",
      'Lead with the outcome. Your first sentence after finishing should answer "what happened" or "what did you find" \u2014 the thing the user would ask for if they said "just give me the TLDR." Supporting detail and reasoning come after, for readers who want them.',
      "",
      "Being readable and being concise are different things, and readable matters more. If the user has to reread your summary or ask you to explain, any time saved by brevity is gone. The way to keep output short is to be selective about what you include (drop details that don't change what the reader would do next), not to compress the writing into fragments, abbreviations, arrow chains like `A \u2192 B \u2192 fails`, or jargon. What you do include, write in complete sentences with the technical terms spelled out. Don't make the reader cross-reference labels or numbering you invented earlier; say what you mean in place.",
      "",
      "Match the response to the question: a simple question gets a direct answer in prose, not headers and sections. Use tables only for short enumerable facts, with explanations in the surrounding prose rather than the cells. Calibrate to the user \u2014 a bit tighter for an expert, more explanatory for someone newer.",
    ].join("\n"),
    afterDefault:
      "Only write a code comment to state a constraint the code itself can't show \u2014 never to say where it came from, what the next line does, or why your change is correct; that's you talking to the reviewer, not the next reader, and it's noise the moment the PR merges.",
  },
} as const;

const CONTEXT_MANAGEMENT_PROMPTS = {
  default: [
    "# Context management",
    "When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue \u2014 you don't need to wrap up early or hand off mid-task.",
  ].join("\n"),
  additional: [
    "When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey",
    "",
    "You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task, so asking 'Want me to\u2026?' or 'Shall I\u2026?' will block the work. For reversible actions that follow from the original request, proceed without asking. Stop only for destructive actions or genuine scope changes the user must decide. Offering follow-ups after the task is done is fine; asking permission before doing the work is not.",
    "",
    "Exception: when the user is describing a problem, asking a question, or thinking out loud rather than requesting a change, the deliverable is your assessment. Report your findings and stop. Don't apply a fix until they ask for one.",
    "",
    "Before ending your turn, check your last paragraph. If it is a plan, an analysis, a question, a list of next steps, or a promise about work you have not done ('I'll\u2026', 'let me know when\u2026'), do that work now with tool calls. That includes retrying after errors and gathering missing information yourself. Do not stop because the context or session is long. End your turn only when the task is complete or you are blocked on input only the user can provide.",
    "",
    "Before running a command that changes system state \u2014 restarts, deletes, config edits \u2014 check that the evidence actually supports that specific action. A signal that pattern-matches to a known failure may have a different cause.",
  ].join("\n"),
} as const;

// [leo] leo-brain 是 Host 登记的用户级 MCP（packages/desktop/src/host/leo/brainTools.ts）。
const LEO_BRAIN_SEARCH_TOOL = "mcp__leo-brain__brain_search";
const LEO_BRAIN_GUIDANCE =
  "- Leo's second brain (mcp__leo-brain__*) holds Leo's own documents, knowledge cards, daily pages, project reports, past decisions, photos and videos. When the question is about Leo, his projects, earlier work or decisions, people in his life, or uses 我的/之前/上次/记得/笔记/资料/大脑, call mcp__leo-brain__brain_search first (brain_brief is not needed), use brain_read for details, and cite the title. If the leo-brain tools are missing or fail, tell the user; never read ~/.config/leo-brain/*, ~/.leoagent/key or ~/.leoagent/treasury.key, and never call the brain endpoint by hand.";

export function buildSessionGuidanceSection(toolNames: readonly string[], hasSkills = false): ContextSection | null {
  const tools = new Set(toolNames);
  const lines = ["# Session-specific guidance"];

  // 当前不输出 Agent 指导段。
  // if (tools.has("Agent")) {
  //   lines.push("- Use the Agent tool with specialized agents when the task at hand matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself.");

  //   let exploreGuide = "- For broad codebase exploration or research that'll take more than 3 queries, spawn Agent with subagent_type=Explore.";
  //   const fallbackSearch = getDirectSearchGuidance(tools);
  //   if (fallbackSearch) {
  //     exploreGuide += ` Otherwise use ${fallbackSearch} directly.`;
  //   }
  //   lines.push(exploreGuide);
  // }

  if (tools.has("Skill") && hasSkills) {
    lines.push("- When the user types `/<skill-name>`, invoke it via Skill. Only use skills listed in the user-invocable skills section \u2014 don't guess.");
  }

  // if (tools.has("AskUserQuestion")) {
  //   lines.push("- Use AskUserQuestion when you need a bounded clarification before proceeding.");
  // }

  // [leo] 第二大脑的路由：MCP server instructions 不进提示词，工具描述只说做什么不说何时用，
  // 模型遇到「我之前…」类问题不会想到查它；工具缺失时还试过自己去读 key 文件。
  if (tools.has(LEO_BRAIN_SEARCH_TOOL)) {
    lines.push(LEO_BRAIN_GUIDANCE);
  }

  if (lines.length <= 1) {
    return null;
  }

  // 只有存在实际 session guidance 时才输出本段，避免向 simple branch 注入空标题。
  return createDynamicSection("Session-specific guidance", "session_guidance", lines.join("\n"));
}

export function buildDynamicBehaviorSection(): ContextSection {
  return createDynamicSection(
    "Dynamic Behavior",
    "dynamic_behavior",
    [
      COMMUNICATION_PROMPTS.additional.beforeDefault,
      "",
      COMMUNICATION_PROMPTS.default,
      COMMUNICATION_PROMPTS.additional.afterDefault,
      "",
      "For actions that are hard to reverse or outward-facing, confirm first unless durably authorized or explicitly told to proceed without asking; approval in one context doesn't extend to the next. Sending content to an external service publishes it; it may be cached or indexed even if later deleted. Before deleting or overwriting, look at the target \u2014 if what you find contradicts how it was described, or you didn't create it, surface that instead of proceeding. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.",
    ].join("\n"),
  );
}

export function buildOutputStyleSection(
  style: ContextBuilderConfig["outputStyle"],
): ContextSection | null {
  if (!style || style.prompt.trim().length === 0) return null;
  return createDynamicSection(
    "Output Style",
    "output_style",
    [`# Output Style: ${style.name}`, style.prompt.trim()].join("\n"),
  );
}

export function buildContextManagementSection(): ContextSection {
  return createDynamicSection(
    "Context Management",
    "context_management",
    [CONTEXT_MANAGEMENT_PROMPTS.default, "", CONTEXT_MANAGEMENT_PROMPTS.additional].join("\n"),
  );
}

function createDynamicSection(
  name: string,
  source: ContextSection["source"],
  content: string,
): ContextSection {
  return {
    name,
    source,
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
