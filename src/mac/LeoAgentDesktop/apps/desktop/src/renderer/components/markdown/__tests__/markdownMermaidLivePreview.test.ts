/**
 * Unit tests for `findMermaidBlocks`.
 *
 * The closure-stale fix (PR #148 review round 2) hinges on two pieces:
 *   - `findMermaidBlocks(doc)` — pure, scans the whole CM doc for
 *     `\`\`\`mermaid` fences and returns block ranges. Tested here.
 *   - `resolveBlockAtLivePos(view, root, source)` — calls
 *     `view.posAtDOM(root)` and looks up which block contains that position.
 *     Untested in this file because it requires an EditorView mounted in a
 *     DOM (jsdom) and the project doesn't yet pull jsdom in for renderer
 *     unit tests. The function body is a thin wrapper around CM's own
 *     `posAtDOM` API — verified manually via CDP during PR development.
 *
 * If we add jsdom to renderer tests in the future, `resolveBlockAtLivePos`
 * gets the obvious "duplicate blocks each resolve to their own slot" +
 * "shifted blocks survive bulk text insert above" coverage.
 */

import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';

import { findMermaidBlocks } from '../markdownMermaidLivePreview';

function docOf(...lines: string[]): Text {
  return Text.of(lines);
}

describe('findMermaidBlocks', () => {
  it('returns empty for docs without any mermaid fence', () => {
    expect(findMermaidBlocks(docOf('# title', '', 'just text'))).toEqual([]);
  });

  it('extracts a single mermaid block with body source preserved', () => {
    const doc = docOf(
      '# title',
      '',
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
      '',
      'after',
    );
    const blocks = findMermaidBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe('flowchart TD\n  A --> B');
    // bodyFrom / bodyEnd should bracket exactly the body so an in-place
    // replace preserves both fence lines.
    expect(blocks[0].bodyFrom).toBe(doc.line(4).from);
    expect(blocks[0].bodyEnd).toBe(doc.line(6).from);
  });

  it('handles an empty mermaid fence (closer right after opener)', () => {
    const doc = docOf('```mermaid', '```');
    const blocks = findMermaidBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe('');
    // Empty body: bodyFrom == bodyEnd == start of closer line so a replace
    // inserts cleanly between the two fence lines.
    expect(blocks[0].bodyFrom).toBe(doc.line(2).from);
    expect(blocks[0].bodyEnd).toBe(doc.line(2).from);
  });

  it('skips an open-ended (unterminated) mermaid fence', () => {
    const doc = docOf('```mermaid', 'flowchart TD', '  A --> B');
    expect(findMermaidBlocks(doc)).toEqual([]);
  });

  it('finds two consecutive blocks at distinct positions', () => {
    const doc = docOf(
      '```mermaid',
      'A --> B',
      '```',
      '',
      '```mermaid',
      'C --> D',
      '```',
    );
    const blocks = findMermaidBlocks(doc);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].source).toBe('A --> B');
    expect(blocks[1].source).toBe('C --> D');
    expect(blocks[0].bodyFrom).toBeLessThan(blocks[1].bodyFrom);
  });

  it('finds duplicate-source blocks at distinct positions (the closure-stale case)', () => {
    // Two identical mermaid blocks (legitimate: tutorial examples). The
    // production code disambiguates these via `view.posAtDOM(root)` at
    // click time — but the underlying block extraction must surface BOTH
    // of them with distinct ranges, otherwise live-pos lookup has nothing
    // to match against.
    const doc = docOf(
      '```mermaid',
      'A --> B',
      '```',
      '',
      '```mermaid',
      'A --> B',
      '```',
    );
    const blocks = findMermaidBlocks(doc);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].source).toBe(blocks[1].source);
    expect(blocks[0].bodyFrom).not.toBe(blocks[1].bodyFrom);
    expect(blocks[0].to).toBeLessThan(blocks[1].from);
  });

  it('supports tilde-style fences', () => {
    const doc = docOf('~~~mermaid', 'flowchart TD', '  A --> B', '~~~');
    const blocks = findMermaidBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe('flowchart TD\n  A --> B');
  });

  it('skips fences that do not target mermaid (e.g., plain code blocks)', () => {
    const doc = docOf(
      '```',
      'just code',
      '```',
      '',
      '```javascript',
      'console.log(1);',
      '```',
    );
    expect(findMermaidBlocks(doc)).toEqual([]);
  });

  it('skips a ````mermaid` example nested inside another fenced block', () => {
    // Documentation files often quote mermaid syntax inside a `\`\`\`markdown`
    // / `\`\`\`md` block. That nested example must NOT be rendered as a live
    // diagram — the user is showing the source ON PURPOSE.
    const doc = docOf(
      '```markdown',
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
      '```',
    );
    expect(findMermaidBlocks(doc)).toEqual([]);
  });

  it('skips a ````mermaid` example nested inside an attributed-info fence', () => {
    // Documentation files commonly write attributed info strings like
    // `\`\`\`markdown title="example"` or `\`\`\`ts highlight=3` — the
    // info-string portion contains spaces, which earlier broke the
    // single-no-space-token regex. The nested mermaid example must NOT
    // render as a live diagram regardless of how the outer fence is
    // attributed.
    const doc = docOf(
      '```markdown title="example"',
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
      '```',
    );
    expect(findMermaidBlocks(doc)).toEqual([]);
  });

  it('skips a 3-backtick mermaid example wrapped in a 4-backtick outer fence', () => {
    // CommonMark §4.5: a fenced code block opens with 3+ chars and the
    // closer must be ≥ as long. The standard escape for *quoting* a real
    // mermaid block in documentation is to wrap it in a 4-backtick outer
    // fence — without 3+ support the outer fence falls through and the
    // inner sample renders as a live diagram.
    const doc = docOf(
      '````markdown',
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
      '````',
    );
    expect(findMermaidBlocks(doc)).toEqual([]);
  });

  it('matches a real mermaid block opened with 4+ backticks', () => {
    // Symmetric: a 4-backtick mermaid fence is also valid CommonMark.
    const doc = docOf('````mermaid', 'flowchart TD', '  A --> B', '````');
    const blocks = findMermaidBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe('flowchart TD\n  A --> B');
  });

  it('rejects a too-short closer for a 4-backtick mermaid fence', () => {
    // The closer must be ≥ opener length. A 3-backtick line inside a
    // 4-backtick block is content, not a closer.
    const doc = docOf('````mermaid', '```', 'still inside', '````');
    const blocks = findMermaidBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe('```\nstill inside');
  });

  it('matches a mermaid fence with attribution after the info-string token', () => {
    // Pandoc / Markdown extensions allow extra attributes after the language
    // token, e.g. `\`\`\`mermaid title="flow"`. Without info-string-token
    // matching this would fall through to FENCE_OPEN_OTHER_RE and render as
    // a plain code block.
    const doc = docOf(
      '```mermaid title="flow"',
      'flowchart TD',
      '  A --> B',
      '```',
    );
    const blocks = findMermaidBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe('flowchart TD\n  A --> B');
  });

  it('matches a mermaid fence with leading whitespace inside the info string', () => {
    // ```` ``` mermaid```` (space between the fence and the lang token).
    // Some Markdown linters auto-format this way; the canonical fence is
    // still mermaid.
    const doc = docOf('``` mermaid', 'flowchart TD', '  A --> B', '```');
    const blocks = findMermaidBlocks(doc);
    expect(blocks).toHaveLength(1);
  });

  it('does NOT match a fence whose info-string token is mermaid-prefixed (mermaidx)', () => {
    // Sanity: token boundary must be enforced — `\`\`\`mermaidx` is a
    // distinct language, not mermaid.
    const doc = docOf('```mermaidx', 'whatever', '```');
    expect(findMermaidBlocks(doc)).toEqual([]);
  });

  it('does NOT treat a 4-space indented fence as a mermaid block (CommonMark indent rule)', () => {
    // CommonMark §4.5: a fence opener may be indented 0–3 spaces. Four-space
    // indentation makes the line an indented code block, NOT a fence — so
    // a literal mermaid sample like `    \`\`\`mermaid` (4 spaces) inside
    // a tutorial must stay raw and not render as a live diagram.
    const doc = docOf(
      '    ```mermaid',
      '    flowchart TD',
      '      A --> B',
      '    ```',
    );
    expect(findMermaidBlocks(doc)).toEqual([]);
  });

  it('accepts up to 3 spaces of indent on a mermaid fence', () => {
    const doc = docOf('   ```mermaid', 'flowchart TD', '  A --> B', '   ```');
    const blocks = findMermaidBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe('flowchart TD\n  A --> B');
  });

  it('skips a ````mermaid` example nested inside a tilde fence whose info string contains backticks', () => {
    // CommonMark: tilde-fence info strings can contain backticks (no
    // ambiguity since the closer is a tilde run). Earlier the single
    // [^`]* check rejected `~~~markdown title=\`example\`` and let the
    // inner mermaid sample render as a live diagram.
    const doc = docOf(
      '~~~markdown title=`example`',
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
      '~~~',
    );
    expect(findMermaidBlocks(doc)).toEqual([]);
  });

  it('rejects a backtick mermaid fence with backticks inside the info string', () => {
    // CommonMark §4.5: backtick fence info strings cannot contain backticks
    // (would create opener/closer ambiguity on the same line). The line
    // `\`\`\`mermaid title=\`example\`` is therefore not a mermaid fence —
    // Markdown leaves it as raw source. Rendering it as a live diagram
    // would let the toolbar edit text the parser keeps as normal source.
    const doc = docOf(
      '```mermaid title=`example`',
      'flowchart TD',
      '  A --> B',
      '```',
    );
    expect(findMermaidBlocks(doc)).toEqual([]);
  });

  it('accepts a tilde mermaid fence with backticks inside the info string', () => {
    // Mirror of the backtick rule: tilde fences allow backticks anywhere
    // in the info string.
    const doc = docOf(
      '~~~mermaid title=`example`',
      'flowchart TD',
      '  A --> B',
      '~~~',
    );
    const blocks = findMermaidBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe('flowchart TD\n  A --> B');
  });

  it('still picks up real mermaid blocks AFTER a non-mermaid fence', () => {
    // Sanity: the outer-fence skip must not eat real mermaid blocks that
    // come later in the doc.
    const doc = docOf(
      '```javascript',
      'const x = 1;',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
    );
    const blocks = findMermaidBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe('flowchart TD\n  A --> B');
  });
});
