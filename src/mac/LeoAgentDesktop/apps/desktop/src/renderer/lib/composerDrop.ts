import {
  COMPOSER_MENTION_MIME,
  decodeComposerMentionPayload,
  type ComposerFileMentionPayload,
} from './composerMentionDrag';

interface ComposerMentionDataTransfer {
  getData(type: string): string;
}

interface ComposerMentionTarget {
  addFileMention(payload: ComposerFileMentionPayload): void;
  addFolderPath(folderPath: string): void;
}

export function consumeComposerMentionDrop(
  dataTransfer: ComposerMentionDataTransfer,
  target: ComposerMentionTarget,
): boolean {
  const mentionPayload = decodeComposerMentionPayload(
    dataTransfer.getData(COMPOSER_MENTION_MIME),
  );
  if (!mentionPayload) return false;
  if (mentionPayload.type === 'directory') {
    target.addFolderPath(mentionPayload.relPath);
    return true;
  }
  target.addFileMention(mentionPayload);
  return true;
}
