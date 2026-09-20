import { peekCanWriteBack, peekFileCaption } from './local-files';

export function peekIsDirty(saved?: string | null, draft?: string | null): boolean {
  if (saved == null || draft == null) return false;
  return draft !== saved;
}

export function canFlushPeekOnSend(input: {
  machine?: string | null;
  projectId?: string | null;
  path?: string | null;
  peek?: string | null;
  draft?: string | null;
}): boolean {
  if (!peekCanWriteBack({
    machine: input.machine,
    projectId: input.projectId,
    path: input.path,
    peek: input.peek,
  })) return false;
  return peekIsDirty(input.peek, input.draft);
}

export function peekFlushedToast(file?: string | null): string {
  const name = peekFileCaption(file);
  return name ? `已先写下 ${name}` : '已先把预览写回去';
}
