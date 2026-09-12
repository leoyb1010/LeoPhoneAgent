import { useCallback, useEffect, useRef, useState } from 'react';

/** Acknowledgement clears only the submitted revision, never the next draft. */
export function useTaskDraft(send: (prompt: string) => boolean | Promise<boolean>) {
  const [draft, setDraftState] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const draftRef = useRef('');
  const revisionRef = useRef(0);
  const pendingRef = useRef<symbol | null>(null);

  useEffect(() => () => { pendingRef.current = null; }, []);

  const setDraft = useCallback((value: string) => {
    draftRef.current = value;
    revisionRef.current += 1;
    setDraftState(value);
  }, []);

  const submit = useCallback(async () => {
    const prompt = draftRef.current.trim();
    if (!prompt || pendingRef.current) return;
    const ticket = Symbol('new-task');
    const revision = revisionRef.current;
    pendingRef.current = ticket;
    setBusy(true);
    setError('');
    try {
      const accepted = await send(prompt);
      if (pendingRef.current === ticket && accepted && revisionRef.current === revision) setDraft('');
    } catch (failure) {
      if (pendingRef.current === ticket) setError(failure instanceof Error ? failure.message : 'Could not start the task');
    } finally {
      if (pendingRef.current === ticket) {
        pendingRef.current = null;
        setBusy(false);
      }
    }
  }, [send, setDraft]);

  return { draft, setDraft, submit, busy, error };
}
