import { useState } from "react";
import { rawDiagnostic, userErrorMessage } from "@/i18n/zh-CN";

/** Only translates the operator-facing explanation, never the original Error. */
export function ChineseError({ error }: { error: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const raw = rawDiagnostic(error);
  const message = userErrorMessage(error);
  return <span>
    <span>{message}</span>
    {raw && raw !== message && <>
      {" "}<button type="button" className="underline underline-offset-2" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? "收起原始诊断" : "查看原始诊断"}
      </button>
      {expanded && <code className="block whitespace-pre-wrap break-words text-xs">{raw}</code>}
    </>}
  </span>;
}
