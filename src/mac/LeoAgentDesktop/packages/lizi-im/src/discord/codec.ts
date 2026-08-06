const MESSAGE_ID_SEPARATOR = '|';
const CUSTOM_ID_LIMIT = 100;
const REF_PREFIX = 'ref:';
const REF_CACHE_CAPACITY = 256;

interface CustomIdBody {
  i: string;
  p: Record<string, unknown>;
}

const refCache = new Map<string, CustomIdBody>();
let refCounter = 0;

export function encodeMessageId(channelId: string, messageId: string): string {
  if (!isValidMessageIdPart(channelId) || !isValidMessageIdPart(messageId)) {
    throw new Error('invalid discord messageId part');
  }
  return `${channelId}${MESSAGE_ID_SEPARATOR}${messageId}`;
}

export function decodeMessageId(encoded: string): { channelId: string; messageId: string } {
  const parts = encoded.split(MESSAGE_ID_SEPARATOR);
  if (parts.length !== 2 || !isValidMessageIdPart(parts[0]) || !isValidMessageIdPart(parts[1])) {
    throw new Error(`invalid discord messageId: ${encoded}`);
  }
  return { channelId: parts[0], messageId: parts[1] };
}

export function encodeCustomId(
  buttonId: string,
  payload: Record<string, unknown>,
): string {
  if (typeof buttonId !== 'string' || buttonId.length === 0) {
    throw new Error('invalid discord custom_id buttonId');
  }

  const body: CustomIdBody = { i: buttonId, p: payload };
  const inline = JSON.stringify(body);
  if (inline.length <= CUSTOM_ID_LIMIT) {
    return inline;
  }

  const token = nextRefToken();
  refCache.set(token, body);
  while (refCache.size > REF_CACHE_CAPACITY) {
    const oldest = refCache.keys().next().value;
    if (oldest === undefined) break;
    refCache.delete(oldest);
  }
  return `${REF_PREFIX}${token}`;
}

export function decodeCustomId(
  customId: string,
): { buttonId: string; payload: Record<string, unknown> } | null {
  if (customId.startsWith(REF_PREFIX)) {
    const found = refCache.get(customId.slice(REF_PREFIX.length));
    return found ? { buttonId: found.i, payload: found.p } : null;
  }

  try {
    const parsed = JSON.parse(customId) as Partial<CustomIdBody>;
    if (typeof parsed.i !== 'string' || !isRecord(parsed.p)) {
      return null;
    }
    return { buttonId: parsed.i, payload: parsed.p };
  } catch {
    return null;
  }
}

function isValidMessageIdPart(part: string): boolean {
  return typeof part === 'string' && part.length > 0 && !part.includes(MESSAGE_ID_SEPARATOR);
}

function nextRefToken(): string {
  refCounter += 1;
  return `${Date.now().toString(36)}${refCounter.toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
