type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => unknown;
};

export function withViewTransition(update: () => void): void {
  const documentWithTransition = document as ViewTransitionDocument;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !documentWithTransition.startViewTransition) {
    update();
    return;
  }
  documentWithTransition.startViewTransition(update);
}
