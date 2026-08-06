import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { MentionChipAttrs } from './MentionChipNode';

interface InsertMentionChipOptions {
  /**
   * Absolute ProseMirror document position. When omitted, the chip is appended
   * at the end to preserve the legacy pending-drop and palette behaviour.
   */
  at?: number;
}

function resolveMentionInsertPos(
  doc: PMNode,
  requestedPos: number | undefined,
): number {
  const endPos = Math.max(0, doc.content.size - 1);
  if (requestedPos === undefined) return endPos;

  const clamped = Math.max(0, Math.min(requestedPos, doc.content.size));
  const $pos = doc.resolve(clamped);
  return $pos.parent.inlineContent ? clamped : endPos;
}

export function appendMentionChip(
  editor: Editor,
  attrs: MentionChipAttrs,
  options: InsertMentionChipOptions = {},
): void {
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      const insertPos = resolveMentionInsertPos(tr.doc, options.at);
      const node = editor.schema.nodes.mentionChip.create(attrs);
      const nodeAfter = insertPos < tr.doc.content.size ? tr.doc.nodeAt(insertPos) : null;
      const hasInlineAtomAfter = Boolean(nodeAfter?.isInline && !nodeAfter.isText);
      const charBefore =
        insertPos > 0 ? tr.doc.textBetween(Math.max(0, insertPos - 1), insertPos, '', '') : '';
      const charAfter =
        !hasInlineAtomAfter && insertPos < tr.doc.content.size
          ? tr.doc.textBetween(insertPos, insertPos + 1, '', '')
          : '';
      const needsLeadingSpace = charBefore.length > 0 && !/\s/.test(charBefore);
      const needsTrailingSpace = !hasInlineAtomAfter && (charAfter.length === 0 || !/\s/.test(charAfter));
      const content = [
        ...(needsLeadingSpace ? [editor.schema.text(' ')] : []),
        node,
        ...(needsTrailingSpace ? [editor.schema.text(' ')] : []),
      ];
      tr.insert(insertPos, content);
      const nextPos = insertPos + content.reduce((sum, item) => sum + item.nodeSize, 0);
      tr.setSelection(TextSelection.near(tr.doc.resolve(nextPos), 1));
      return true;
    })
    .run();
}
