import { describe, expect, it } from 'vitest';

import {
  MAX_PROPOSAL_FILES,
  validateProposal,
  type ProposalFile,
} from '../stagingValidation.pure';

const skillMd = (name: string, description = 'A test skill for validation.'): string =>
  `---\nname: ${name}\ndescription: ${description}\nversion: "0.1.0"\n---\n\n# Test\n\nBody.\n`;

const file = (relPath: string, text: string | null, size = text?.length ?? 10): ProposalFile => ({
  relPath,
  size,
  text,
});

describe('validateProposal', () => {
  it('accepts a valid proposal with matching dir name', () => {
    const v = validateProposal({
      dirName: 'my-skill',
      files: [file('SKILL.md', skillMd('my-skill'))],
    });
    expect(v).toMatchObject({ ok: true, skillName: 'my-skill', needsRename: false });
  });

  it('flags rename when frontmatter name differs from dir name', () => {
    const v = validateProposal({
      dirName: 'wrong-dir',
      files: [file('SKILL.md', skillMd('right-name'))],
    });
    expect(v).toMatchObject({ ok: true, skillName: 'right-name', needsRename: true });
  });

  it('rejects missing SKILL.md', () => {
    const v = validateProposal({ dirName: 'x', files: [file('README.md', 'hi')] });
    expect(v).toMatchObject({ ok: false });
    if (!v.ok) expect(v.reason).toContain('SKILL.md missing');
  });

  it('rejects invalid frontmatter (missing description)', () => {
    const v = validateProposal({
      dirName: 'x',
      files: [file('SKILL.md', '---\nname: x\n---\n\nBody.\n')],
    });
    expect(v).toMatchObject({ ok: false });
    if (!v.ok) expect(v.reason).toContain('frontmatter invalid');
  });

  it('rejects invalid skill names (uppercase / spaces / leading dash)', () => {
    for (const bad of ['My-Skill', 'has space', '-lead']) {
      const v = validateProposal({
        dirName: 'x',
        files: [file('SKILL.md', skillMd(bad))],
      });
      expect(v.ok, bad).toBe(false);
    }
  });

  it('rejects too many files', () => {
    const files = [file('SKILL.md', skillMd('big-skill'))];
    for (let i = 0; i <= MAX_PROPOSAL_FILES; i += 1) {
      files.push(file(`references/f${i}.md`, 'x'));
    }
    const v = validateProposal({ dirName: 'big-skill', files });
    expect(v).toMatchObject({ ok: false });
    if (!v.ok) expect(v.reason).toContain('too many files');
  });

  it('rejects oversized total bytes', () => {
    const v = validateProposal({
      dirName: 'fat-skill',
      files: [file('SKILL.md', skillMd('fat-skill')), file('assets/big.bin', null, 30 * 1024 * 1024)],
    });
    expect(v).toMatchObject({ ok: false });
    if (!v.ok) expect(v.reason).toContain('too large');
  });

  it('rejects proposals containing non-regular entries (symlinks)', () => {
    const v = validateProposal({
      dirName: 'sneaky',
      files: [file('SKILL.md', skillMd('sneaky'))],
      violations: ['scripts/link-to-home'],
    });
    expect(v).toMatchObject({ ok: false });
    if (!v.ok) expect(v.reason).toContain('non-regular');
  });

  it('aggregates redaction warnings from text files without failing', () => {
    const v = validateProposal({
      dirName: 'leaky-skill',
      files: [
        file('SKILL.md', skillMd('leaky-skill')),
        file('references/notes.md', 'reach me at foo@bar.com, key sk-abcdefghijklmnopqrstuvwx'),
      ],
    });
    expect(v).toMatchObject({ ok: true });
    if (v.ok) {
      expect(v.redactionWarnings).toContain('email');
      expect(v.redactionWarnings).toContain('api-key');
    }
  });
});

describe('computeProposalFingerprint', () => {
  it('二进制文件按内容哈希参与指纹:同尺寸换字节指纹必变;顺序无关', async () => {
    const { computeProposalFingerprint } = await import('../stagingValidation.pure');
    const base = { relPath: 'SKILL.md', size: 5, text: 'hello' };
    const binA = [base, { relPath: 'assets/logo.png', size: 8, text: null, contentHash: 'aaa' }];
    const binB = [base, { relPath: 'assets/logo.png', size: 8, text: null, contentHash: 'bbb' }];
    expect(computeProposalFingerprint(binA)).not.toBe(computeProposalFingerprint(binB));
    expect(computeProposalFingerprint(binA)).toBe(computeProposalFingerprint([...binA].reverse()));
    // 文本内容变化同样反映
    expect(computeProposalFingerprint([{ ...base, text: 'hello2', size: 6 }])).not.toBe(
      computeProposalFingerprint([base]),
    );
  });
});
