// [remote-ctl-mac] 手机回答模型的提问(AskUserQuestion),见 docs/specs/leo-link-remote-controls.md「会话操作」。
// 答复内容与桌面 ElicitationDialog.buildElicitationResponseContent 同形,CLI 的 interaction-broker 按它取答案。
import type { ZCodeStreamEvent } from "@zcode/shared";

import type { HarnessEvent } from "./journal.js";

type ElicitationRequest = Extract<ZCodeStreamEvent, { type: "elicitation_request" }>;
type Option = { label: string; value: string; description?: string };
export type PendingQuestion = { question: string; header?: string; multiSelect: boolean; options: Option[] };

const TEXT_MAX = 4_000;

/** 内核的提问 → 统一成多题结构(旧的单题请求只有 message / options)。 */
export function normalizeQuestions(request: ElicitationRequest): PendingQuestion[] {
  const raw = request.questions?.length
    ? request.questions
    : [{ question: request.message, header: request.header ?? "", options: request.options, multiSelect: request.multiSelect }];
  return raw.map((item) => ({
    question: item.question,
    ...(item.header ? { header: item.header } : {}),
    multiSelect: item.multiSelect === true,
    options: item.options.map((option) => ({
      label: option.label || option.value,
      value: option.value || option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
  }));
}

export function questionRequestEvent(questionId: string, questions: PendingQuestion[]): HarnessEvent {
  return {
    event: "question.request",
    question_id: questionId,
    questions: questions.map((item) => ({
      question: item.question,
      ...(item.header ? { header: item.header } : {}),
      options: item.options.map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
      multi_select: item.multiSelect,
    })),
  };
}

export type ParsedAnswer = { decline: true } | { content: Record<string, unknown> } | { error: string };

/**
 * 手机的答复 → elicitation accept 的 content。selected 是选项的 label(也认 value);text 是自由输入。
 * 某题没答就不放进去(和桌面一样:可选澄清,agent 按最佳判断继续)。
 */
export function parseAnswer(body: Record<string, unknown>, questions: PendingQuestion[]): ParsedAnswer {
  if (body["decline"] === true) return { decline: true };
  const rawAnswers = body["answers"];
  if (!Array.isArray(rawAnswers)) return { error: "answers 必须是数组（或 decline: true）" };
  const answers: Record<string, string> = {};
  const content: Record<string, unknown> = { answers };
  for (const [index, question] of questions.entries()) {
    const entry = rawAnswers.find((candidate) => record(candidate)["question"] === question.question) ?? rawAnswers[index];
    const item = record(entry);
    if (item["question"] !== undefined && item["question"] !== question.question) continue;
    const selected = Array.isArray(item["selected"]) ? item["selected"].filter((value): value is string => typeof value === "string") : [];
    const values = selected.map((label) => question.options.find((option) => option.label === label || option.value === label)?.value ?? label);
    const text = typeof item["text"] === "string" ? item["text"].trim().slice(0, TEXT_MAX) : "";
    const picked = [...(question.multiSelect ? values : values.slice(0, 1)), ...(text ? [text] : [])];
    if (!picked.length) continue;
    answers[question.question] = picked.join(", ");
    content[`answer_${index}`] = question.multiSelect ? picked : picked[0];
    if (questions.length === 1) content["answer"] = content[`answer_${index}`];
  }
  return { content };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
