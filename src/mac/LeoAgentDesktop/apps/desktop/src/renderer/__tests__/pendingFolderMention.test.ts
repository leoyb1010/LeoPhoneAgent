import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
);

const useAttachmentsSource = readFileSync(
  resolve(__dirname, '..', 'hooks', 'useAttachments.ts'),
  'utf8',
);

describe('pending folder mention queue', () => {
  it('uses an explicit version signal to wake ChatInput when folder paths are queued', () => {
    expect(useAttachmentsSource).toContain('pendingFoldersVersion');
    expect(useAttachmentsSource).toMatch(/setPendingFoldersVersion\(\(version\) => version \+ 1\)/);
    expect(chatInputSource).toMatch(/pendingFoldersVersion:\s*number/);
    expect(chatInputSource).toMatch(/addFolderPath,\s*pendingFoldersVersion,\s*consumePendingFolders/);
    expect(chatInputSource).toMatch(/\}, \[editor, consumePendingFolders, pendingFoldersVersion\]\);/);
  });
});
