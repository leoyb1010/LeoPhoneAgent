import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, FormEvent, MutableRefObject, RefObject, SetStateAction } from 'react';

import {
  clearQueuedMessage,
  readQueuedMessage,
  writeQueuedMessage,
  type QueuedSendOptions,
} from '../utils/chatStorage';

export type QueuedDraft = {
  content: string;
  images: File[];
  options?: QueuedSendOptions;
};

type SubmitHandler = (event: FormEvent<HTMLFormElement>) => Promise<void>;

type UseQueuedChatDraftArgs = {
  sessionKey: string | null;
  isLoading: boolean;
  setInput: Dispatch<SetStateAction<string>>;
  inputValueRef: MutableRefObject<string>;
  setAttachedImages: Dispatch<SetStateAction<File[]>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  handleSubmitRef: MutableRefObject<SubmitHandler | null>;
};

const createFakeSubmitEvent = () => ({
  preventDefault: () => undefined,
}) as unknown as FormEvent<HTMLFormElement>;

const restoreQueuedDraft = (sessionKey: string): QueuedDraft | null => {
  const saved = readQueuedMessage(sessionKey);
  return saved ? { content: saved.content, images: [], options: saved.options } : null;
};

export function useQueuedChatDraft({
  sessionKey,
  isLoading,
  setInput,
  inputValueRef,
  setAttachedImages,
  textareaRef,
  handleSubmitRef,
}: UseQueuedChatDraftArgs) {
  const [queuedDraft, setQueuedDraft] = useState<QueuedDraft | null>(() => {
    if (typeof window === 'undefined' || !sessionKey) return null;
    return restoreQueuedDraft(sessionKey);
  });
  const queuedDraftSessionRef = useRef<string | null>(sessionKey);

  const queueDraft = useCallback((draft: QueuedDraft) => {
    queuedDraftSessionRef.current = sessionKey;
    setQueuedDraft(draft);
  }, [sessionKey]);

  const wasLoadingRef = useRef(isLoading);
  const flushSessionKeyRef = useRef(sessionKey);
  useEffect(() => {
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = isLoading;
    if (flushSessionKeyRef.current !== sessionKey) {
      flushSessionKeyRef.current = sessionKey;
      return;
    }
    if (isLoading || !queuedDraft) return;

    const delay = wasLoading ? 0 : 750;
    const timer = setTimeout(() => {
      if (sessionKey && !readQueuedMessage(sessionKey)) {
        setQueuedDraft(null);
        return;
      }
      setQueuedDraft(null);
      setInput(queuedDraft.content);
      inputValueRef.current = queuedDraft.content;
      setAttachedImages(queuedDraft.images);
      setTimeout(() => handleSubmitRef.current?.(createFakeSubmitEvent()), 0);
    }, delay);
    return () => clearTimeout(timer);
  }, [handleSubmitRef, inputValueRef, isLoading, queuedDraft, sessionKey, setAttachedImages, setInput]);

  const editQueuedDraft = useCallback(() => {
    if (!queuedDraft) return;
    setQueuedDraft(null);
    setInput(queuedDraft.content);
    inputValueRef.current = queuedDraft.content;
    setAttachedImages(queuedDraft.images);
    textareaRef.current?.focus();
  }, [inputValueRef, queuedDraft, setAttachedImages, setInput, textareaRef]);

  const deleteQueuedDraft = useCallback(() => setQueuedDraft(null), []);

  useEffect(() => {
    if (!sessionKey || queuedDraftSessionRef.current !== sessionKey) return;
    if (queuedDraft?.content) {
      writeQueuedMessage(sessionKey, { content: queuedDraft.content, options: queuedDraft.options });
    } else {
      clearQueuedMessage(sessionKey);
    }
  }, [queuedDraft, sessionKey]);

  useEffect(() => {
    queuedDraftSessionRef.current = sessionKey;
    setQueuedDraft(sessionKey ? restoreQueuedDraft(sessionKey) : null);
  }, [sessionKey]);

  return { queuedDraft, queueDraft, editQueuedDraft, deleteQueuedDraft };
}
