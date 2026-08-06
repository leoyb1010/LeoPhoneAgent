import { describe, expect, it } from 'vitest';

import { inspectExternalEditedInsertedText } from '../DictationExternalEditInspector.js';

describe('DictationExternalEditInspector', () => {
  it('extracts edited pasted text between stable anchors', () => {
    const result = inspectExternalEditedInsertedText({
      originalContext: {
        selectionBefore: '请使用 ',
        selectedText: '',
        selectionAfter: ' 完成这个功能',
      },
      currentContext: {
        selectionBefore: '请使用 ',
        selectedText: '',
        selectionAfter: 'Vibe Coding 完成这个功能',
      },
      insertedText: 'Web Coding',
    });

    expect(result).toMatchObject({
      ok: true,
      reason: 'edited_text_extracted',
      editedText: 'Vibe Coding',
    });
  });

  it('rejects unchanged inserted text', () => {
    const result = inspectExternalEditedInsertedText({
      originalContext: {
        selectionBefore: 'prefix ',
        selectedText: '',
        selectionAfter: ' suffix',
      },
      currentContext: {
        selectionBefore: 'prefix ',
        selectedText: '',
        selectionAfter: 'voice text suffix',
      },
      insertedText: 'voice text',
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'unchanged',
    });
  });

  it('extracts full replacement text when there are no anchors', () => {
    const result = inspectExternalEditedInsertedText({
      originalContext: {
        selectionBefore: '',
        selectedText: '',
        selectionAfter: '',
      },
      currentContext: {
        selectionBefore: '',
        selectedText: 'OpenAI 直连',
        selectionAfter: '',
      },
      insertedText: 'Open AI zhi lian',
    });

    expect(result).toMatchObject({
      ok: true,
      reason: 'replacement_text_extracted',
      editedText: 'OpenAI 直连',
    });
  });

  it('uses full field content when the caret moved away from the pasted range', () => {
    const result = inspectExternalEditedInsertedText({
      originalContext: {
        selectionBefore: '请使用 ',
        selectedText: '',
        selectionAfter: ' 完成这个功能',
        fullFieldContent: '请使用  完成这个功能',
        selectionLocation: 4,
        selectionLength: 0,
      },
      currentContext: {
        selectionBefore: '新的光标位置',
        selectedText: '',
        selectionAfter: '',
        fullFieldContent: '请使用 Vibe Coding 完成这个功能\n新的光标位置',
      },
      insertedText: 'Web Coding',
    });

    expect(result).toMatchObject({
      ok: true,
      reason: 'edited_text_extracted',
      editedText: 'Vibe Coding',
    });
  });

  it('falls back to approximate replacement when the external app hides pre-paste chrome', () => {
    const result = inspectExternalEditedInsertedText({
      originalContext: {
        selectionBefore: '发送给 周子墨, 林子航, 孙浩然, 郑凯文等5人\n',
        selectedText: '',
        selectionAfter: '\u200b\n\u200b\n\u200b',
        fullFieldContent: '发送给 周子墨, 林子航, 孙浩然, 郑凯文等5人\n\u200b\n\u200b\n\u200b',
        selectionLocation: 26,
        selectionLength: 0,
      },
      currentContext: {
        selectionBefore: '看看',
        selectedText: '',
        selectionAfter: '在飞书上的修改正常了吗？\u200b\n\u200b\n\u200b',
        fullFieldContent: '看看在飞书上的修改正常了吗？\u200b\n\u200b\n\u200b',
      },
      insertedText: '看他在飞书上的修改正常了吗？',
    });

    expect(result).toMatchObject({
      ok: true,
      reason: 'approximate_replacement_text_extracted',
      editedText: '看看在飞书上的修改正常了吗？',
    });
  });

  it('rejects approximate extraction for very short pasted text', () => {
    const result = inspectExternalEditedInsertedText({
      originalContext: {
        selectionBefore: 'prefix ',
        selectedText: '',
        selectionAfter: ' suffix',
        fullFieldContent: 'prefix  suffix',
        selectionLocation: 7,
        selectionLength: 0,
      },
      currentContext: {
        selectionBefore: '好吧',
        selectedText: '',
        selectionAfter: '',
        fullFieldContent: '好吧',
      },
      insertedText: '好的',
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'left_anchor_not_found',
    });
  });

});
