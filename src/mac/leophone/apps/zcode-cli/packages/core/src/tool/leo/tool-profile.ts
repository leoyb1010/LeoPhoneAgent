// ============================================================
// [leo] 把按模型的档位接到 Edit / Read 工具上
// ============================================================
// registerBuiltInTools 用 withLeoModelProfile 包装 Edit 与 Read：
//   - resolveModelContract：按本轮模型给出对应的描述与入参 JSON Schema（replace / hashline / 无行号）；
//   - handler：执行前把解析好的档位登记到本次 ToolExecutionContext 上（WeakMap，调用结束即可回收），
//     上游 handler 里的 [leo] 钩子用 getLeoToolProfile(context) 取用。
// 没经过包装的直接调用（测试、其它入口）按内置默认档位解析，行为一致。

import {
  LeoEditHashlineModeInputJsonSchema,
  LeoEditReplaceModeInputJsonSchema,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolExecutionModelContext } from "../types.js";
import {
  resolveLeoModelToolProfile,
  type LeoAgentSettings,
  type LeoModelToolProfile,
  type LeoReadLineFormat,
} from "./model-profile.js";

const profilesByContext = new WeakMap<ToolExecutionContext, LeoModelToolProfile>();

export const LEO_PLAIN_READ_MAX_LINES = 2000;
export const LEO_PLAIN_READ_MAX_BYTES = 50 * 1024;

export function getLeoToolProfile(context: ToolExecutionContext): LeoModelToolProfile {
  return profilesByContext.get(context) ?? resolveLeoModelToolProfile(context.model, undefined);
}

export function withLeoModelProfile(entry: ToolEntry, settings: LeoAgentSettings | undefined): ToolEntry {
  const name = entry.metadata.name;
  if (name !== "Edit" && name !== "Read") return entry;
  const resolveProfile = (context: { model?: ToolExecutionModelContext["model"] }) =>
    resolveLeoModelToolProfile(context.model, settings);

  return {
    ...entry,
    resolveModelContract: (context) => {
      const profile = resolveProfile(context);
      if (name === "Edit") {
        return {
          description: leoEditDescription(profile),
          inputSchema:
            profile.editMode === "hashline"
              ? LeoEditHashlineModeInputJsonSchema
              : LeoEditReplaceModeInputJsonSchema,
        };
      }
      const base = entry.resolveModelContract?.(context);
      return {
        ...base,
        description: leoReadDescription(
          base?.description ?? entry.metadata.description ?? "",
          profile.readLineFormat,
        ),
      };
    },
    handler: (input, context) => {
      profilesByContext.set(context, resolveProfile(context));
      return entry.handler(input, context);
    },
  };
}

const EDIT_COMMON_RULES = [
  "- You must Read the file in this conversation before editing, or the call will fail.",
];

const EDIT_MULTI_RULE =
  "- To change several places in one file, send ONE call with `edits: [{old_string, new_string}, ...]` instead of several calls. Every old_string is matched against the original file (not after earlier edits), must be unique (or set replace_all) and must not overlap another edit; they all apply together or none do.";

export function leoEditDescription(profile: LeoModelToolProfile): string {
  if (profile.editMode === "hashline") {
    return [
      "Edits a file using LINE#HASH anchors from Read output (or exact string replacement).",
      "",
      ...EDIT_COMMON_RULES,
      '- Read shows every line as `LINE#HASH:content` (e.g. `12#VK:  return x;`). Refer to a line by its anchor "12#VK". Never put the `LINE#HASH:` prefix into new lines.',
      '- `edits: [{"op": "replace", "pos": "12#VK", "end": "14#QZ", "lines": ["...", "..."]}]` replaces lines 12-14 (omit `end` for one line; `lines: []` deletes). Other ops: "insert_after" / "insert_before" (lines next to pos), "delete" (pos..end), "append" / "prepend" (end / start of file, no pos).',
      "- All edits in one call refer to the file as you last read it and must not overlap; they apply together or not at all. A stale anchor rejects the call and shows the current anchors: use those.",
      "- After an edit, lines below it are renumbered: use the anchors returned in the result, or Read again.",
      "- You can also replace exact text with `old_string` / `new_string` (unique in the file), at the top level or as items of `edits`.",
    ].join("\n");
  }
  return [
    "Performs exact string replacement in a file.",
    "",
    ...EDIT_COMMON_RULES,
    profile.readLineFormat === "plain"
      ? "- `old_string` must match the file exactly, including indentation, and be unique — the edit fails otherwise."
      : "- `old_string` must match the file exactly, including indentation, and be unique — the edit fails otherwise. Strip the Read line prefix (line number + tab) before matching.",
    "- `replace_all: true` replaces every occurrence instead.",
    EDIT_MULTI_RULE,
  ].join("\n");
}

const READ_NUMBERED_LINE = "- Results are returned using cat -n format, with line numbers starting at 1";

export function leoReadDescription(base: string, format: LeoReadLineFormat): string {
  if (format === "numbered" || !base.includes(READ_NUMBERED_LINE)) return base;
  const replacement =
    format === "hashline"
      ? "- Results show every line as `LINE#HASH:content` (e.g. `12#VK:  return x;`), line numbers starting at 1. Pass the LINE#HASH anchors to Edit; the prefix is not part of the file."
      : `- Results are the plain file content without line numbers. Long files come in windows of up to ${LEO_PLAIN_READ_MAX_LINES} lines / ${LEO_PLAIN_READ_MAX_BYTES / 1024}KB (whole lines only); follow the [Showing lines …] hint with offset to continue.`;
  return base.replace(READ_NUMBERED_LINE, replacement);
}
