/**
 * [leo][WP-52] R2 输入事件的校验(纯逻辑,不引 electron,单测直接跑)。契约见 docs/specs/leo-screen.md「R2」。
 *
 * DataChannel 上来的是手机发的任意字符串:这里只放行认识的形状,数值夹到范围内,重新序列化后才交给 leo-input。
 * 助手程序因此不必再防御奇怪输入,也不会被塞进多余字段。
 */

type InputEvent =
  | { t: "move"; x: number; y: number }
  | { t: "down" | "up"; b: MouseButton; x?: number; y?: number }
  | { t: "click"; b: MouseButton; n: number; x?: number; y?: number }
  | { t: "scroll"; dx: number; dy: number; x?: number; y?: number }
  | { t: "key"; code: string; mods: Modifier[]; phase: "press" | "down" | "up" }
  | { t: "text"; s: string };

type MouseButton = "left" | "right" | "middle";
type Modifier = "cmd" | "shift" | "alt" | "ctrl";

const MODIFIERS = new Set<Modifier>(["cmd", "shift", "alt", "ctrl"]);
const BUTTONS = new Set<MouseButton>(["left", "right", "middle"]);
/** W3C KeyboardEvent.code 里 leo-input 认识的那些(与 native/leo-input/main.swift 的表一致)。 */
const KEY_CODE =
  /^(Key[A-Z]|Digit[0-9]|Numpad([0-9]|Decimal|Multiply|Add|Divide|Enter|Subtract|Equal)|F([1-9]|1[0-7])|Arrow(Left|Right|Up|Down)|Enter|Tab|Space|Backspace|Delete|Escape|Home|End|PageUp|PageDown|Equal|Minus|BracketLeft|BracketRight|Quote|Semicolon|Backslash|Comma|Slash|Period|Backquote|CapsLock|(Meta|Shift|Alt|Control)(Left|Right))$/;
/** 一条 text 事件最多这么多字;更长的手机端自己分条发(DataChannel 有序可靠,不会乱)。 */
export const MAX_TEXT_CHARS = 2_000;

const unit = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;

const pixels = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(5_000, Math.max(-5_000, value)))
    : 0;

function position(raw: Record<string, unknown>): { x?: number; y?: number } | null {
  if (raw["x"] === undefined && raw["y"] === undefined) return {};
  const x = unit(raw["x"]);
  const y = unit(raw["y"]);
  return x === null || y === null ? null : { x, y };
}

export function parseInputEvent(data: string): InputEvent | null {
  if (data.length > 16_384) return null;
  let raw: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    raw = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const button = BUTTONS.has(raw["b"] as MouseButton) ? (raw["b"] as MouseButton) : "left";
  switch (raw["t"]) {
    case "move": {
      const x = unit(raw["x"]);
      const y = unit(raw["y"]);
      return x === null || y === null ? null : { t: "move", x, y };
    }
    case "down":
    case "up": {
      const at = position(raw);
      return at ? { t: raw["t"], b: button, ...at } : null;
    }
    case "click": {
      const at = position(raw);
      const count = raw["n"] === 2 || raw["n"] === 3 ? raw["n"] : 1;
      return at ? { t: "click", b: button, n: count, ...at } : null;
    }
    case "scroll": {
      const at = position(raw);
      return at ? { t: "scroll", dx: pixels(raw["dx"]), dy: pixels(raw["dy"]), ...at } : null;
    }
    case "key": {
      const code = raw["code"];
      if (typeof code !== "string" || !KEY_CODE.test(code)) return null;
      const mods = Array.isArray(raw["mods"])
        ? [...new Set(raw["mods"].filter((mod): mod is Modifier => MODIFIERS.has(mod as Modifier)))]
        : [];
      const phase = raw["phase"] === "down" || raw["phase"] === "up" ? raw["phase"] : "press";
      return { t: "key", code, mods, phase };
    }
    case "text": {
      const text = raw["s"];
      if (typeof text !== "string" || text.length === 0) return null;
      // 控制字符(除了换行、Tab)不当文字注入;要回车 / 删除请发 key 事件。
      const clean = [...text]
        .filter((char) => char === "\n" || char === "\t" || char.codePointAt(0)! >= 0x20)
        .slice(0, MAX_TEXT_CHARS)
        .join("");
      return clean ? { t: "text", s: clean } : null;
    }
    default:
      return null;
  }
}
