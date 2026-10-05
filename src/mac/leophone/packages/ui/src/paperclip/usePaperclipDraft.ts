import { useRef, useState } from "react";
import { matchesPaperclipReplyConfirmation } from "./replyDraftConfirmation.js";
import { createUuid } from "@zcode/shared";
import { logger } from "@/logger.js";
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
    // 与 save 一致：存储不可用（隐私模式、配额、权限）时不能让清草稿抛错打断已确认的流程。
    try {
      localStorage.removeItem(key);
    } catch {
      /* 存储不可用时仅清理当前窗口草稿。 */
    }
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
    if (previouslySubmitted) return;
    // 首次提交在发送前被拒（服务层发布 rejected 回执）：回滚为可编辑，保留正文与请求编号。
    logger.warn("[paperclip] 提交未发出，草稿已恢复为可编辑");
    update({ submitted: false, submittedAt: null });
  };
  return {
    draft,
    update,
    clear,
    clearConfirmed: (confirmation: PaperclipSnapshot["confirmedReply"]) => {
      if (
        !matchesPaperclipReplyConfirmation(
          {
            receiptId: current.current.id,
            body: current.current.body,
            draft: current.current.body,
            identity: paperclipIdentityKey(
              snapshot.origin,
              snapshot.user?.id ?? "",
              snapshot.companyId,
            ),
          },
          confirmation ?? null,
          issueId,
        )
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
