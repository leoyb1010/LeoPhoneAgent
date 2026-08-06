import { describe, expect, it } from 'vitest';

import {
  parseMarkdownTable,
  renderedOffsetToSourceOffset,
  serializeMarkdownTable,
  sourceOffsetToRenderedOffset,
} from '@/components/markdown/markdownTableLivePreview';

describe('markdown table parsing and serialization', () => {
  it('stably round-trips a regular GitHub-style table after width normalization', () => {
    const source = [
      '| Name | Status |',
      '| --- | :---: |',
      '| Alpha | ready |',
      '| Beta | blocked |',
    ].join('\n');

    const model = parseMarkdownTable(source);

    expect(model).not.toBeNull();
    const serialized = serializeMarkdownTable(model!);
    expect(serializeMarkdownTable(parseMarkdownTable(serialized)!)).toBe(serialized);
    expect(serialized).toBe(
      [
        '| Name  | Status  |',
        '| ----- | :-----: |',
        '| Alpha | ready   |',
        '| Beta  | blocked |',
      ].join('\n'),
    );
  });

  it('serializes edited padded cells from ragged rows', () => {
    const model = parseMarkdownTable(
      [
        '| Name | Status | Owner |',
        '| --- | --- | --- |',
        '| Alpha | ready |',
      ].join('\n'),
    );

    expect(model).not.toBeNull();
    expect(model!.rows[0][2].sourceFrom).toBeUndefined();

    model!.rows[0][2] = { ...model!.rows[0][2], text: 'Lizi' };

    expect(serializeMarkdownTable(model!, model!.sourceWidths)).toBe(
      [
        '| Name    | Status   | Owner   |',
        '| ------- | -------- | ------- |',
        '| Alpha   | ready    | Lizi    |',
      ].join('\n'),
    );
  });
});

describe('markdown table inline offset mapping', () => {
  it('maps concealed strong markup between source and rendered offsets', () => {
    const source = '**bold**';

    expect(sourceOffsetToRenderedOffset(source, 0, [])).toBe(0);
    expect(sourceOffsetToRenderedOffset(source, 4, [])).toBe(2);
    expect(sourceOffsetToRenderedOffset(source, 8, [])).toBe(4);

    expect(renderedOffsetToSourceOffset(source, 0, [])).toBe(2);
    expect(renderedOffsetToSourceOffset(source, 2, [])).toBe(4);
    expect(renderedOffsetToSourceOffset(source, 4, [])).toBe(6);
  });

  it('keeps revealed inline markup offsets one-to-one', () => {
    const source = '**bold**';
    const revealRanges = [{ from: 0, to: source.length }];

    expect(sourceOffsetToRenderedOffset(source, 2, revealRanges)).toBe(2);
    expect(sourceOffsetToRenderedOffset(source, 8, revealRanges)).toBe(8);
    expect(renderedOffsetToSourceOffset(source, 2, revealRanges)).toBe(2);
    expect(renderedOffsetToSourceOffset(source, 8, revealRanges)).toBe(8);
  });

  it('maps markdown cell line breaks as one rendered character', () => {
    const source = 'a<br>z';

    expect(sourceOffsetToRenderedOffset(source, 0, [])).toBe(0);
    expect(sourceOffsetToRenderedOffset(source, 5, [])).toBe(2);
    expect(sourceOffsetToRenderedOffset(source, 6, [])).toBe(3);

    expect(renderedOffsetToSourceOffset(source, 0, [])).toBe(0);
    expect(renderedOffsetToSourceOffset(source, 1, [])).toBe(1);
    expect(renderedOffsetToSourceOffset(source, 2, [])).toBe(5);
    expect(renderedOffsetToSourceOffset(source, 3, [])).toBe(6);
  });
});
