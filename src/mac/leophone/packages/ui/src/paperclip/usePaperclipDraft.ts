import { useRef, useState } from "react";
import { createUuid } from "@zcode/shared";
import {
  creationRetryPermitted,
  paperclipIdentityKey,
  type PaperclipSnapshot,
} from "@zcode/services";

interface Draft {
  id: string;
  title: string;
  body: string;
  agentId: string;
  submitted: boolean;
  submittedAt: number | null;
}
const fresh = (): Draft => ({
  id: createUuid(),
  title: "",
  body: "",
  agentId: "",
  submitted: false,
  submittedAt: null,
});
export function usePaperclipDraft(snapshot: PaperclipSnapshot, issueId = "create") {
  const key = `leo.paperclip.draft.v1:${paperclipIdentityKey(snapshot.origin, snapshot.user?.id ?? "", snapshot.companyId)}:${issueId}`;
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? "null") as Draft | null;
      if (
        value &&
        typeof value.id === "string" &&
        typeof value.title === "string" &&
        typeof value.body === "string" &&
        typeof value.agentId === "string" &&
        typeof value.submitted === "boolean"
      )
        return {
          ...value,
          submittedAt: typeof value.submittedAt === "number" ? value.submittedAt : null,
        };
    } catch {
      /* 草稿损坏不能阻止工作台显示。 */
    }
    return fresh();
  });
  const current = useRef(draft);
  current.current = draft;
  const save = (value: Draft) => {
    current.current = value;
    setDraft(value);
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 存储不可用时保留当前窗口草稿。 */
    }
  };
  const update = (patch: Partial<Draft>) => save({ ...draft, ...patch });
  const clear = () => {
    const value = fresh();
    current.current = value;
    setDraft(value);
    localStorage.removeItem(key);
  };
  const submit = () => {
    const value = {
      ...draft,
      submitted: true,
      submittedAt: draft.submitted ? draft.submittedAt : Date.now(),
    };
    save(value);
    return value;
  };
  const rejected = (previouslySubmitted: boolean) => {
    // 重试被拒绝不证明原提交未被接收，不能解锁未知内容或延长首次计时。
    if (!previouslySubmitted) update({ submitted: false, submittedAt: null });
  };
  return {
    draft,
    update,
    clear,
    clearConfirmed: (confirmation: PaperclipSnapshot["confirmedReply"]) => {
      if (
        !confirmation ||
        confirmation.receiptId !== current.current.id ||
        confirmation.body !== current.current.body ||
        confirmation.issueId !== issueId ||
        confirmation.identity !==
          paperclipIdentityKey(snapshot.origin, snapshot.user?.id ?? "", snapshot.companyId)
      )
        return false;
      clear();
      return true;
    },
    submit,
    rejected,
    creationRetryAllowed:
      !draft.submitted || (draft.submittedAt !== null && creationRetryPermitted(draft.submittedAt)),
  };
}
