export const COMPOSER_MENTION_MIME = 'application/x-xdmaker-composer-mention';

export interface ComposerFileMentionPayload {
  type: 'file';
  relPath: string;
  name: string;
}

export interface ComposerDirectoryMentionPayload {
  type: 'directory';
  relPath: string;
  name: string;
}

export type ComposerMentionPayload =
  | ComposerFileMentionPayload
  | ComposerDirectoryMentionPayload;

export function encodeComposerMentionPayload(
  payload: ComposerMentionPayload,
): string {
  return JSON.stringify(payload);
}

export function decodeComposerMentionPayload(
  raw: string,
): ComposerMentionPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ComposerMentionPayload>;
    if (parsed.type !== 'file' && parsed.type !== 'directory') return null;
    if (typeof parsed.relPath !== 'string' || parsed.relPath.length === 0) return null;
    if (typeof parsed.name !== 'string' || parsed.name.length === 0) return null;
    if (parsed.type === 'file') {
      return {
        type: 'file',
        relPath: parsed.relPath,
        name: parsed.name,
      };
    }
    return {
      type: 'directory',
      relPath: parsed.relPath,
      name: parsed.name,
    };
  } catch {
    return null;
  }
}
