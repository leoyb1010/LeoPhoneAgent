import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';

import { clearQueuedMessage, readQueuedMessage, type QueuedSendOptions } from '../utils/chatStorage';

export type QueuedDraft = {
  content: string;
  images: File[];
  options?: QueuedSendOptions;
};

type Args = {
  sessionKey: string | null;
  setInput: Dispatch<SetStateAction<string>>;
  inputValueRef: MutableRefObject<string>;
  setAttachedImages: Dispatch<SetStateAction<File[]>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

function restore(sessionKey: string | null): QueuedDraft | null {
  const saved = sessionKey ? readQueuedMessage(sessionKey) : null;
  return saved ? { content: saved.content, images: [], options: saved.options } : null;
}

/** Older releases stored an unsent local draft. Recover it for review, never auto-run it. */
export function useQueuedChatDraft({ sessionKey, setInput, inputValueRef, setAttachedImages, textareaRef }: Args) {
  const [stored, setStored] = useState(() => ({ sessionKey, draft: restore(sessionKey) }));
  const queuedDraft = stored.sessionKey === sessionKey ? stored.draft : null;
  useEffect(() => { setStored({ sessionKey, draft: restore(sessionKey) }); }, [sessionKey]);

  const deleteQueuedDraft = useCallback(() => {
    if (sessionKey) clearQueuedMessage(sessionKey);
    setStored({ sessionKey, draft: null });
  }, [sessionKey]);

  const editQueuedDraft = useCallback(() => {
    if (!queuedDraft) return;
    setInput(queuedDraft.content);
    inputValueRef.current = queuedDraft.content;
    setAttachedImages(queuedDraft.images);
    deleteQueuedDraft();
    textareaRef.current?.focus();
  }, [deleteQueuedDraft, inputValueRef, queuedDraft, setAttachedImages, setInput, textareaRef]);

  return { queuedDraft, editQueuedDraft, deleteQueuedDraft };
}
