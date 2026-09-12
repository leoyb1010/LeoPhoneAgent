const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

type ModalOptions = {
  root: HTMLElement;
  content: HTMLElement;
  depth: number;
  onDismiss: () => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  restoreFocusTo?: HTMLElement | null;
};
type Layer = ModalOptions & { restore: HTMLElement | null; originalZIndex: string };
type ModalState = {
  layers: Layer[];
  originalInert: Map<HTMLElement, string | null>;
  originalOverflow: string;
  disposeListeners: () => void;
};
const documents = new WeakMap<Document, ModalState>();

function focusable(content: HTMLElement): HTMLElement[] {
  return Array.from(content.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => (
    !element.closest('[inert], [hidden]') && element.getClientRects().length > 0
  ));
}

function focusFirst(content: HTMLElement) {
  (focusable(content)[0] ?? content).focus();
}

function restoreInert(element: HTMLElement, original: string | null) {
  if (element.hasAttribute('data-dialog-layer') && element.getAttribute('data-state') === 'closed') element.setAttribute('inert', '');
  else if (original === null) element.removeAttribute('inert');
  else element.setAttribute('inert', original);
}

function refresh(doc: Document, state: ModalState) {
  const top = state.layers.at(-1);
  if (!top) return;
  for (const node of Array.from(doc.body.children)) {
    const element = node as HTMLElement;
    if (!state.originalInert.has(element)) state.originalInert.set(element, element.getAttribute('inert'));
    if (element === top.root || element.contains(top.root)) {
      element.removeAttribute('inert');
    } else {
      element.setAttribute('inert', '');
    }
  }
  state.layers.forEach((layer, index) => { layer.root.style.zIndex = String(10000 + index * 2); });
}

/** One owner for all modal focus. Nested portals cannot close/trap their parent. */
export function activateModalLayer(options: ModalOptions): () => void {
  const doc = options.content.ownerDocument;
  let state = documents.get(doc);
  if (!state) {
    state = { layers: [], originalInert: new Map(), originalOverflow: doc.body.style.overflow, disposeListeners: () => undefined };
    documents.set(doc, state);
    const current = state;
    const onKey = (event: KeyboardEvent) => {
      const top = current.layers.at(-1);
      if (!top || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        top.onEscapeKeyDown?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        top.onDismiss();
      } else if (event.key === 'Tab') {
        const controls = focusable(top.content);
        const first = controls[0];
        const last = controls.at(-1);
        if (!first || doc.activeElement === top.content || !top.content.contains(doc.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last ?? top.content : first ?? top.content).focus();
        } else if (event.shiftKey && doc.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && doc.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const onFocus = (event: FocusEvent) => {
      const top = current.layers.at(-1);
      if (top && !top.content.contains(event.target as Node)) focusFirst(top.content);
    };
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('focusin', onFocus);
    const Observer = doc.defaultView?.MutationObserver;
    const observer = Observer ? new Observer(() => refresh(doc, current)) : null;
    observer?.observe(doc.body, { childList: true });
    doc.body.style.overflow = 'hidden';
    state.disposeListeners = () => {
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('focusin', onFocus);
      observer?.disconnect();
    };
  }
  const current = state;
  const layer: Layer = {
    ...options,
    restore: options.restoreFocusTo ?? doc.activeElement as HTMLElement | null,
    originalZIndex: options.root.style.zIndex,
  };
  current.layers.push(layer);
  current.layers.sort((left, right) => left.depth - right.depth);
  refresh(doc, current);
  if (current.layers.at(-1) === layer) focusFirst(layer.content);

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const wasTop = current.layers.at(-1) === layer;
    current.layers = current.layers.filter((item) => item !== layer);
    // A route change may remove a parent before its child. Keep the original
    // return path instead of restoring focus into a closing parent portal.
    for (const other of current.layers) {
      if (layer.root.contains(other.restore)) other.restore = layer.restore;
    }
    layer.root.style.zIndex = layer.originalZIndex;
    if (!current.layers.length) {
      current.disposeListeners();
      for (const [element, value] of current.originalInert) restoreInert(element, value);
      doc.body.style.overflow = current.originalOverflow;
      documents.delete(doc);
    } else {
      refresh(doc, current);
    }
    if (wasTop) {
      const parent = current.layers.at(-1);
      const target = layer.restore;
      if (target?.isConnected && !target.closest('[inert], [hidden]') && (!parent || parent.content.contains(target))) target.focus();
      else if (parent) focusFirst(parent.content);
    }
  };
}
