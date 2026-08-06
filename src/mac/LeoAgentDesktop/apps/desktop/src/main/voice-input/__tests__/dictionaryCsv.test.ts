import { describe, expect, it } from 'vitest';

import {
  MAX_VOICE_INPUT_DICTIONARY_ENTRIES,
  createManualVoiceInputDictionaryEntry,
  mergeVoiceInputDictionaryCsvTerms,
  parseVoiceInputDictionaryCsv,
} from '../../../shared/voiceInputData.js';

describe('voice input dictionary CSV import', () => {
  it('parses a one-column CSV with quoted values', () => {
    const result = parseVoiceInputDictionaryCsv('Claude Code\n"OpenAI, Inc."\n\n"Vibe Coding"\n');

    expect(result).toEqual({
      ok: true,
      terms: ['Claude Code', 'OpenAI, Inc.', 'Vibe Coding'],
      duplicateRowCount: 0,
      skippedTooLongCount: 0,
    });
  });

  it('rejects rows with multiple non-empty columns', () => {
    expect(parseVoiceInputDictionaryCsv('Claude Code,Cloud Code')).toEqual({
      ok: false,
      reason: 'invalidCsv',
    });
  });

  it('parses CRLF line endings', () => {
    expect(parseVoiceInputDictionaryCsv('Claude Code\r\nGPT\r\n')).toEqual({
      ok: true,
      terms: ['Claude Code', 'GPT'],
      duplicateRowCount: 0,
      skippedTooLongCount: 0,
    });
  });

  it('strips a leading UTF-8 BOM', () => {
    expect(parseVoiceInputDictionaryCsv(String.fromCharCode(0xfeff) + 'Claude Code')).toEqual({
      ok: true,
      terms: ['Claude Code'],
      duplicateRowCount: 0,
      skippedTooLongCount: 0,
    });
  });

  it('rejects fields containing a NUL byte', () => {
    expect(parseVoiceInputDictionaryCsv('Claude\0Code')).toEqual({
      ok: false,
      reason: 'invalidCsv',
    });
  });

  it('rejects characters after a closing quote', () => {
    expect(parseVoiceInputDictionaryCsv('"Claude"Code')).toEqual({
      ok: false,
      reason: 'invalidCsv',
    });
  });

  it('deduplicates rows and skips overlong terms', () => {
    const longTerm = 'x'.repeat(121);
    const result = parseVoiceInputDictionaryCsv(`Claude Code\nclaude code\n${longTerm}\n`);

    expect(result).toEqual({
      ok: true,
      terms: ['Claude Code'],
      duplicateRowCount: 1,
      skippedTooLongCount: 1,
    });
  });

  it('merges imported terms as manual entries and skips existing terms', () => {
    const existing = createManualVoiceInputDictionaryEntry('Claude Code');
    if (!existing) throw new Error('failed to create fixture dictionary entry');

    const result = mergeVoiceInputDictionaryCsvTerms([existing], ['Cloud Code', 'Claude Code']);

    expect(result.importedCount).toBe(1);
    expect(result.duplicateExistingCount).toBe(1);
    expect(result.capacitySkippedCount).toBe(0);
    expect(result.entries.map((entry) => entry.text)).toEqual(['Claude Code', 'Cloud Code']);
    expect(result.entries[1].source).toBe('manual');
  });

  it('does not exceed dictionary capacity', () => {
    const existing = Array.from({ length: MAX_VOICE_INPUT_DICTIONARY_ENTRIES }, (_, index) => {
      const entry = createManualVoiceInputDictionaryEntry(`term-${index}`);
      if (!entry) throw new Error('failed to create fixture dictionary entry');
      return entry;
    });

    const result = mergeVoiceInputDictionaryCsvTerms(existing, ['extra-term']);

    expect(result.importedCount).toBe(0);
    expect(result.capacitySkippedCount).toBe(1);
    expect(result.entries).toHaveLength(MAX_VOICE_INPUT_DICTIONARY_ENTRIES);
  });
});
