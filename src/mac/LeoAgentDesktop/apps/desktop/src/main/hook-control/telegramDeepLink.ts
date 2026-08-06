/**
 * Telegram deep-link policy for Cindy provider binding.
 *
 * The server supplies a short-lived link, but main re-validates the complete
 * URL immediately before shell.openExternal.  Renderer input is never treated
 * as a URL authority.  This keeps credentials, alternate hosts, ports,
 * fragments and query smuggling away from the shell boundary.
 */

export class TelegramDeepLinkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramDeepLinkValidationError';
  }
}

/** Telegram usernames are 5-32 ASCII chars; bot accounts end in "bot". */
export const TELEGRAM_BOT_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{1,28}[Bb][Oo][Tt]$/;
/** 32 random bytes in canonical unpadded base64url form. */
export const TELEGRAM_BIND_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function fail(reason: string): never {
  throw new TelegramDeepLinkValidationError(reason);
}

function validateBase(url: URL, input: string): void {
  if (input.trim() !== input) fail('Telegram link must not include surrounding whitespace');
  if (url.protocol !== 'https:') fail('Telegram link must use HTTPS');
  if (url.hostname !== 't.me') fail('Telegram link host must be exactly t.me');
  const authority = /^[A-Za-z]+:\/\/([^/?#]+)/.exec(input)?.[1];
  // URL normalizes an explicit default :443 port away, so inspect the raw
  // authority as well before handing a link to Electron's shell.
  if (authority?.toLowerCase() !== 't.me') {
    fail('Telegram link must not include credentials or a port');
  }
  if (url.port) fail('Telegram link must not include a port');
  if (url.username || url.password) fail('Telegram link must not include credentials');
  // URL.hash is also '' for an explicit trailing '#', while URL.toString()
  // preserves that delimiter. Inspect the source so even an empty fragment is
  // excluded from the canonical shell boundary.
  if (input.includes('#')) fail('Telegram link must not include a fragment');
}

function validateBotPath(url: URL): string {
  if (url.pathname.includes('%')) fail('Telegram bot username must not be encoded');
  const match = /^\/([^/]+)$/.exec(url.pathname);
  const username = match?.[1] ?? '';
  if (!TELEGRAM_BOT_USERNAME_RE.test(username)) fail('Invalid Telegram bot username');
  return username;
}

export interface ValidTelegramConnectLink {
  url: string;
  botUsername: string;
  token: string;
}

/** Parse the only URL shape accepted for a Cindy Telegram bind attempt. */
export function parseTelegramConnectUrl(input: string): ValidTelegramConnectLink {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail('Invalid Telegram binding URL');
  }
  validateBase(url, input);
  const botUsername = validateBotPath(url);
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== 'start') {
    fail('Telegram binding URL must contain only the start parameter');
  }
  const token = entries[0]?.[1] ?? '';
  if (!TELEGRAM_BIND_TOKEN_RE.test(token)) fail('Invalid Telegram binding token');
  // Reject duplicate/encoded parameter spellings even if URLSearchParams would
  // decode them into an apparently valid value.
  if (url.search !== `?start=${token}`) fail('Telegram binding URL is not canonical');
  return { url: url.toString(), botUsername, token };
}

export function telegramBotUrl(botUsername: string): string {
  if (!TELEGRAM_BOT_USERNAME_RE.test(botUsername)) fail('Invalid Telegram bot username');
  return `https://t.me/${botUsername}`;
}

export function telegramAddToGroupUrl(botUsername: string): string {
  return `${telegramBotUrl(botUsername)}?startgroup=true`;
}

/** Validate all Telegram URLs that the Settings actions may hand to Electron shell. */
export function validateTelegramExternalUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail('Invalid Telegram URL');
  }
  validateBase(url, input);
  const botUsername = validateBotPath(url);
  if (url.search === '') {
    if (input.includes('?')) fail('Telegram link must not include an empty query');
    return telegramBotUrl(botUsername);
  }
  if (url.search === '?startgroup=true') return telegramAddToGroupUrl(botUsername);
  return parseTelegramConnectUrl(input).url;
}
