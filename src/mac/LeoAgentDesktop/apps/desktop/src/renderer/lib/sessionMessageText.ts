/**
 * Resolve the user-facing text behind a message-anchored session deep link.
 *
 * Only conversational rows are eligible. Tool payloads and other structured
 * metadata deliberately have no fallback stringify path: showing raw JSON in
 * a compact reference chip would both leak implementation detail and make the
 * chip look like it references a whole transcript fragment.
 */
import type { Message } from '@/lib/ccAgent.types';
import { stripChatQuoteMarkerLines } from '@/lib/chatQuotes';
import { parseUserContent } from '@/lib/imageRef';
import { aroundMessagesByClientIdFor } from '@/lib/makerTransport';

function trimmedText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Extract readable message text without serializing tool or SDK metadata. */
export function sessionMessageDisplayText(message: Message): string | null {
  if (message.role === 'user') {
    const parsed = parseUserContent(message.content);
    const text = parsed.quotesEncoded
      ? stripChatQuoteMarkerLines(parsed.text).trim()
      : parsed.text.trim();
    if (text) return text;

    const attachmentNames = [
      ...parsed.images.map((image) => image.originalName),
      ...parsed.files.map((file) => file.name),
    ].filter(Boolean);
    return attachmentNames.length > 0 ? attachmentNames.join(' · ') : null;
  }

  if (message.role === 'assistant') {
    const direct = trimmedText(message.content);
    if (direct) return direct;

    // Defensive compatibility for text-block arrays. Do not stringify any
    // other object shape: those are SDK/tool metadata rather than prose.
    if (Array.isArray(message.content)) {
      const text = message.content
        .flatMap((block) => {
          if (!block || typeof block !== 'object') return [];
          const candidate = block as { type?: unknown; text?: unknown };
          return candidate.type === 'text' && typeof candidate.text === 'string'
            ? [candidate.text]
            : [];
        })
        .join('')
        .trim();
      return text || null;
    }
  }

  return null;
}

/** Fetch exactly one anchored row, routed to its owning local/remote device. */
export async function resolveSessionMessageText(
  sessionId: string,
  clientId: string,
): Promise<string | null> {
  const rows = await aroundMessagesByClientIdFor(sessionId, clientId, { radius: 0 });
  const target = rows.find((message) => message.clientId === clientId);
  return target ? sessionMessageDisplayText(target) : null;
}
