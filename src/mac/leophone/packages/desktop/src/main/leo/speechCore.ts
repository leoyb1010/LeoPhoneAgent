/**
 * [leo][WP-60] 语音输入 / 朗读的纯逻辑(不引 electron,单测直接跑)。规则见 docs/specs/leo-speech.md。
 */
import { validateQuickAccelerator } from "./quickPanelCore.js";

const DEFAULT_SPEECH_ACCELERATOR = "Alt+`";

export interface SpeechSettings {
  /** 按住快捷键说话(写进当前输入框)。 */
  dictationEnabled: boolean;
  /** 回复动作栏的「朗读」按钮。 */
  readAloudEnabled: boolean;
  accelerator: string;
  /** 听写语言;缺省跟系统。 */
  locale: string | null;
}

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  dictationEnabled: true,
  readAloudEnabled: true,
  accelerator: DEFAULT_SPEECH_ACCELERATOR,
  locale: null,
};

export function parseSpeechSettings(raw: unknown): SpeechSettings {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const accelerator = validateQuickAccelerator(value["accelerator"]);
  const locale =
    typeof value["locale"] === "string" && /^[a-z]{2,3}([-_][A-Za-z]{2,4})?$/.test(value["locale"])
      ? value["locale"]
      : null;
  return {
    dictationEnabled: value["dictationEnabled"] !== false,
    readAloudEnabled: value["readAloudEnabled"] !== false,
    accelerator: accelerator.ok ? accelerator.accelerator : DEFAULT_SPEECH_ACCELERATOR,
    locale,
  };
}

export type SpeechEvent =
  | { type: "ready"; locale?: string }
  | { type: "installing" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; code: string; message: string }
  | { type: "done" };

/** 助手程序 stdout 的一行 → 事件;认不出的行丢掉(不让半行或调试输出进到界面)。 */
export function parseSpeechLine(line: string): SpeechEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  switch (event["type"]) {
    case "ready":
      return typeof event["locale"] === "string"
        ? { type: "ready", locale: event["locale"] }
        : { type: "ready" };
    case "installing":
    case "done":
      return { type: event["type"] };
    case "partial":
    case "final":
      return typeof event["text"] === "string"
        ? { type: event["type"], text: event["text"] }
        : null;
    case "error":
      return {
        type: "error",
        code: typeof event["code"] === "string" ? event["code"] : "failed",
        message: typeof event["message"] === "string" ? event["message"] : "语音助手出错",
      };
    default:
      return null;
  }
}

/** 朗读前把 Markdown 变成能念的文字:代码块不念、链接只念文字、去掉强调与标题符号。 */
export function markdownToSpeech(markdown: string, maxChars = 4_000): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " 代码略。 ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, "$2")
    .replace(/\|/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return [...text].length > maxChars ? `${[...text].slice(0, maxChars).join("")}……` : text;
}
