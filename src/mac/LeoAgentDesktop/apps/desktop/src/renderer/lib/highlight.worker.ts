/**
 * highlight.worker.ts
 * ---------------------------------------------------------------------------
 * Module Web Worker that runs highlight.js off the main thread.
 *
 * Why this exists:
 *   TextLightbox previews can hand us multi-MB text/code files. Calling
 *   highlight.js synchronously on a 5–30 MB string blocks the React commit
 *   for seconds — the spinner freezes, Esc stops responding, the modal
 *   feels dead. Running highlight.js inside a Worker keeps the main thread
 *   free for the spinner animation and user input; once the Worker resolves
 *   we hand the highlighted HTML back as a single string and the main
 *   thread does a tiny `dangerouslySetInnerHTML` insertion.
 *
 * Wire format (request/response):
 *   Request:  { id: string; code: string; lang: string }
 *   Response: { id: string; ok: true;  html: string }
 *           | { id: string; ok: false; error: string }
 *
 * Lifecycle:
 *   Owner code (TextLightbox) lazy-instantiates a single Worker via
 *   `new Worker(new URL('./highlight.worker.ts', import.meta.url),
 *                { type: 'module' })` and calls `worker.terminate()` on close.
 */

import hljs from 'highlight.js';

type HighlightRequest = { id: string; code: string; lang: string };
type HighlightResponse =
  | { id: string; ok: true; html: string }
  | { id: string; ok: false; error: string };

self.addEventListener('message', (event: MessageEvent<HighlightRequest>) => {
  const { id, code, lang } = event.data || ({} as HighlightRequest);
  if (!id) return;

  try {
    // `getLanguage` may return undefined for niche aliases — fall back to
    // auto-detect rather than throwing, so the caller still gets HTML.
    const language = lang && hljs.getLanguage(lang) ? lang : undefined;
    const html = language
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : hljs.highlightAuto(code).value;
    const response: HighlightResponse = { id, ok: true, html };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const response: HighlightResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(response);
  }
});

// Mark this file as a module so Vite treats it as `type: 'module'` worker.
export {};
