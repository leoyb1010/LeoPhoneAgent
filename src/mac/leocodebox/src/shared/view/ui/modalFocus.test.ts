import assert from 'node:assert/strict';
import test from 'node:test';

import { activateModalLayer } from './modalFocus';

// This small DOM fixture exercises our focus ownership policy. Real browser
// keyboard/AX checks are also required; it does not emulate browser tab order.
class ElementFixture {
  parentElement: ElementFixture | null = null;
  children: ElementFixture[] = [];
  attrs = new Map<string, string>();
  style = { zIndex: '', overflow: '' };
  isConnected = true;
  tabIndex = -1;
  constructor(readonly ownerDocument: DocumentFixture, readonly name: string, readonly focusable = false) {}
  add(child: ElementFixture) { child.parentElement = this; this.children.push(child); return child; }
  contains(node: unknown): boolean { return node === this || this.children.some((child) => child.contains(node)); }
  focus() { this.ownerDocument.activeElement = this; }
  getAttribute(key: string) { return this.attrs.get(key) ?? null; }
  hasAttribute(key: string) { return this.attrs.has(key); }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  removeAttribute(key: string) { this.attrs.delete(key); }
  getClientRects() { return this.hasAttribute('hidden') ? [] : [{}]; }
  closest(): ElementFixture | null { return this.hasAttribute('inert') || this.hasAttribute('hidden') ? this : this.parentElement?.closest() ?? null; }
  querySelectorAll(): ElementFixture[] {
    return this.children.flatMap((child) => [ ...(child.focusable ? [child] : []), ...child.querySelectorAll() ]);
  }
}
class DocumentFixture {
  body = new ElementFixture(this, 'body');
  activeElement: ElementFixture | null = null;
  defaultView = null;
  listeners = new Map<string, Set<EventListener>>();
  addEventListener(name: string, callback: EventListener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(callback);
  }
  removeEventListener(name: string, callback: EventListener) { this.listeners.get(name)?.delete(callback); }
  key(key: string, shiftKey = false) {
    let prevented = false;
    const event = { key, shiftKey, get defaultPrevented() { return prevented; }, preventDefault() { prevented = true; }, stopPropagation() {}, target: this.activeElement };
    for (const listener of this.listeners.get('keydown') ?? []) listener(event as unknown as Event);
    return prevented;
  }
  layer(name: string) {
    const root = this.body.add(new ElementFixture(this, `${name}-root`));
    const content = root.add(new ElementFixture(this, name));
    const first = content.add(new ElementFixture(this, `${name}-first`, true));
    const last = content.add(new ElementFixture(this, `${name}-last`, true));
    return { root, content, first, last };
  }
}
const activate = (layer: ReturnType<DocumentFixture['layer']>, onDismiss: () => void, depth = 0) => activateModalLayer({
  root: layer.root as unknown as HTMLElement,
  content: layer.content as unknown as HTMLElement,
  onDismiss,
  depth,
});

test('opening isolates background, focuses the dialog and restores the original trigger and inert value', () => {
  const doc = new DocumentFixture();
  const app = doc.body.add(new ElementFixture(doc, 'app'));
  const trigger = app.add(new ElementFixture(doc, 'project trigger', true));
  const alreadyInert = doc.body.add(new ElementFixture(doc, 'already inert'));
  alreadyInert.setAttribute('inert', 'inert');
  doc.body.style.overflow = 'clip';
  trigger.focus();
  const layer = doc.layer('drawer');
  const close = activate(layer, () => undefined);
  assert.equal(doc.activeElement?.name, 'drawer-first');
  assert.equal(app.hasAttribute('inert'), true);
  assert.equal(layer.root.hasAttribute('inert'), false);
  layer.last.focus();
  assert.equal(doc.key('Tab'), true);
  assert.equal(doc.activeElement?.name, 'drawer-first');
  assert.equal(doc.key('Tab', true), true);
  assert.equal(doc.activeElement?.name, 'drawer-last');
  close();
  assert.equal(doc.activeElement?.name, 'project trigger');
  assert.equal(app.hasAttribute('inert'), false);
  assert.equal(alreadyInert.getAttribute('inert'), 'inert');
  assert.equal(doc.body.style.overflow, 'clip');
});

test('only the top nested dialog receives Escape, then focus returns inside its parent', () => {
  const doc = new DocumentFixture();
  const app = doc.body.add(new ElementFixture(doc, 'app'));
  app.focus();
  const parent = doc.layer('drawer');
  let parentDismissed = 0;
  const closeParent = activate(parent, () => { parentDismissed += 1; });
  parent.last.focus();
  const child = doc.layer('new-project');
  let childDismissed = 0;
  const closeChild = activate(child, () => { childDismissed += 1; }, 1);
  assert.equal(parent.root.hasAttribute('inert'), true);
  doc.key('Escape');
  assert.equal(childDismissed, 1);
  assert.equal(parentDismissed, 0);
  closeChild();
  assert.equal(doc.activeElement?.name, 'drawer-last');
  assert.equal(parent.root.hasAttribute('inert'), false);
  assert.equal(app.hasAttribute('inert'), true);
  closeParent();
  assert.equal(app.hasAttribute('inert'), false);
});

test('a dialog with no enabled controls remains a focus boundary', () => {
  const doc = new DocumentFixture();
  const layer = doc.layer('empty');
  layer.first.setAttribute('hidden', '');
  layer.last.setAttribute('hidden', '');
  const close = activate(layer, () => undefined);
  assert.equal(doc.activeElement?.name, 'empty');
  assert.equal(doc.key('Tab'), true);
  assert.equal(doc.activeElement?.name, 'empty');
  close();
});

test('closing a lower layer does not restore focus through an active child', () => {
  const doc = new DocumentFixture();
  const app = doc.body.add(new ElementFixture(doc, 'app'));
  app.focus();
  const parent = doc.layer('parent');
  const closeParent = activate(parent, () => undefined);
  const child = doc.layer('child');
  const closeChild = activate(child, () => undefined, 1);
  closeParent();
  assert.equal(doc.activeElement?.name, 'child-first');
  assert.equal(app.hasAttribute('inert'), true);
  closeChild();
  assert.equal(app.hasAttribute('inert'), false);
});

test('closing animation stays inert while the background focus is restored', () => {
  const doc = new DocumentFixture();
  const trigger = doc.body.add(new ElementFixture(doc, 'trigger', true));
  trigger.focus();
  const layer = doc.layer('dialog');
  layer.root.setAttribute('data-dialog-layer', '');
  layer.root.setAttribute('data-state', 'open');
  const close = activate(layer, () => undefined);
  layer.root.setAttribute('data-state', 'closed');
  layer.root.setAttribute('inert', '');
  close();
  assert.equal(layer.root.hasAttribute('inert'), true, 'fade-out must not leave tabbable controls');
  assert.equal(doc.activeElement?.name, 'trigger');
});
