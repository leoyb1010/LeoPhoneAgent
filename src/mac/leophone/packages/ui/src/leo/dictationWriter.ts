/**
 * [leo][WP-60] 把听写文字实时写进当前输入框:每来一版就把上一版整段替换掉。
 *
 * 走浏览器原生的「选中 → insertText」:Lexical 输入框、普通 textarea / input 都按真实输入处理(撤销栈、
 * 草稿持久化、字数统计都照常),不需要改上游输入框组件。替换范围按字形簇(grapheme)往回选。
 */

function graphemeCount(text: string): number {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
  }
  return [...text].length;
}

function isEditableTarget(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
  return (
    element instanceof HTMLInputElement &&
    element.type === "text" &&
    !element.readOnly &&
    !element.disabled
  );
}

/** 当前焦点在可编辑区就用它;否则找页面上可见的聊天输入框。 */
export function findDictationTarget(doc: Document = document): HTMLElement | null {
  const active = doc.activeElement;
  if (isEditableTarget(active)) return active;
  const candidates = [
    ...doc.querySelectorAll<HTMLElement>('[data-lexical-editor="true"][contenteditable="true"]'),
  ];
  return candidates.find((element) => element.offsetParent !== null) ?? null;
}

export class DictationWriter {
  private written = "";

  constructor(private readonly target: HTMLElement) {}

  /** 用新文本替换上一次写入的那段;text 为空则删掉上一段。 */
  update(text: string): void {
    if (text === this.written) return;
    const doc = this.target.ownerDocument;
    if (doc.activeElement !== this.target) this.target.focus();
    if (this.target instanceof HTMLTextAreaElement || this.target instanceof HTMLInputElement) {
      const end = this.target.selectionEnd ?? this.target.value.length;
      this.target.setSelectionRange(Math.max(0, end - this.written.length), end);
    } else if (this.written) {
      const selection = doc.getSelection();
      selection?.collapseToEnd();
      for (let i = graphemeCount(this.written); i > 0; i -= 1) {
        selection?.modify("extend", "backward", "character");
      }
    }
    if (text) doc.execCommand("insertText", false, text);
    else if (this.written) doc.execCommand("delete");
    this.written = text;
  }
}
