/**
 * fileChipCursor.test.ts
 * ---------------------------------------------------------------------------
 * Regression tests for: file-modal-and-toast-polish (2026-04-19) — symptom #2
 *
 * The file-chip on a UserMessage attachment and on the ToolCallCard expanded
 * Read/Edit list must use `cursor-pointer` (a hand). Previously they used
 * `cursor-zoom-in` (a magnifying-glass) which mis-suggested image-preview
 * semantics for plain-text files.
 *
 * Image thumbnails / <img> tags must KEEP `cursor-zoom-in` because they truly
 * are image previews — only the FILE chip's two call-sites flipped.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const userMessage = readFileSync(
  resolve(__dirname, '..', 'components', 'chat', 'UserMessage.tsx'),
  'utf8',
);

const toolCallCard = readFileSync(
  resolve(__dirname, '..', 'components', 'chat', 'ToolCallCard.tsx'),
  'utf8',
);

const agentActionRow = readFileSync(
  resolve(__dirname, '..', 'components', 'chat', 'AgentActionRow.tsx'),
  'utf8',
);

describe('File chip cursor — points, not zooms (symptom #2)', () => {
  it('UserMessage file chip uses cursor-pointer (not cursor-zoom-in)', () => {
    // Hunt for the attachment chip <button> by its stable file-chip key. The
    // chip carries the user-bg/border tokens. The chip class
    // list must include `cursor-pointer` and must NOT regress to
    // `cursor-zoom-in`.
    const chipBlockStart = userMessage.indexOf('key={`file-${idx}-${f.path}`}');
    expect(chipBlockStart).toBeGreaterThan(-1);
    const chipBlockEnd = userMessage.indexOf('</button>', chipBlockStart);
    const chipBlock = userMessage.slice(chipBlockStart, chipBlockEnd);
    expect(chipBlock).toMatch(/cursor-pointer/);
    expect(chipBlock).not.toMatch(/cursor-zoom-in/);
  });

  it('ToolCallCard preview chip uses cursor-pointer (not cursor-zoom-in)', () => {
    // The ToolCallCard chip is the one that calls `setPreviewPath(abs)` —
    // anchor the slice on that handler so the assertion is robust to other
    // unrelated code in the file.
    const idx = toolCallCard.indexOf('setPreviewPath(abs)');
    expect(idx).toBeGreaterThan(-1);
    const blockEnd = toolCallCard.indexOf('</button>', idx);
    const block = toolCallCard.slice(idx, blockEnd);
    expect(block).toMatch(/cursor-pointer/);
    expect(block).not.toMatch(/cursor-zoom-in/);
  });

  it('AgentActionRow file chip on the current compact path uses cursor-pointer', () => {
    const idx = agentActionRow.indexOf('data-agent-action-file-chip="true"');
    expect(idx).toBeGreaterThan(-1);
    const blockEnd = agentActionRow.indexOf('const onRowContextMenu', idx);
    const block = agentActionRow.slice(idx, blockEnd);
    expect(block).toMatch(/cursor-pointer/);
    expect(block).not.toMatch(/cursor-zoom-in/);
  });
});
