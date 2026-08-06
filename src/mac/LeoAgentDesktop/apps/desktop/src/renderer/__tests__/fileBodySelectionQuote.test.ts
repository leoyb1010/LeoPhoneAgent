/**
 * FileBodyView selection quote regression tests.
 *
 * Markdown live-preview can replace source ranges with rendered CodeMirror
 * widgets. File quotes must therefore use the editor document selection text,
 * while the DOM selection remains only the ownership / geometry signal.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const fileBodySource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'workdir-browse', 'FileBodyView.tsx'),
  'utf8',
);
const editorSource = readFileSync(
  resolve(__dirname, '..', 'components', 'markdown', 'PlaintextEditor.tsx'),
  'utf8',
);
const buttonSource = readFileSync(
  resolve(__dirname, '..', 'components', 'chat', 'SelectionQuoteButton.tsx'),
  'utf8',
);

describe('FileBodyView — selection quote source text', () => {
  it('uses the CodeMirror document selection slice for file quote text', () => {
    expect(editorSource).toContain('getSelectionText: () => string | null;');
    expect(editorSource).toContain('return view.state.doc.sliceString(from, to);');
    expect(fileBodySource).toContain('editorRef.current?.getSelectionText()');
    expect(fileBodySource).toContain('getQuoteText={getSelectedSourceText}');
    expect(buttonSource).toContain('const raw = getQuoteText?.() ?? sel.toString();');
  });
});
