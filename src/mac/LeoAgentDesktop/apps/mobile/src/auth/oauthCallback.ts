export interface OAuthCallbackPayload {
  code: string;
  state: string;
}

/** Matches only the configured scheme/authority/path; query parameters remain variable. */
export function matchesOAuthCallbackUrl(
  rawUrl: string,
  expectedUrl: string,
): boolean {
  try {
    const actual = new URL(rawUrl);
    const expected = new URL(expectedUrl);
    const normalizePath = (pathname: string) =>
      pathname === '/' ? '' : pathname;
    return (
      actual.protocol === expected.protocol &&
      actual.username === expected.username &&
      actual.password === expected.password &&
      actual.hostname === expected.hostname &&
      actual.port === expected.port &&
      normalizePath(actual.pathname) === normalizePath(expected.pathname)
    );
  } catch {
    return false;
  }
}

export function parseOAuthCallbackUrl(rawUrl: string): OAuthCallbackPayload {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error('INVALID_CALLBACK_URL');
  }

  const error = url.searchParams.get('error');
  if (error) throw Object.assign(new Error(error), { code: error });

  const code = url.searchParams.get('code');
  if (!code) throw new Error('INVALID_AUTH_CODE');

  const state = url.searchParams.get('state');
  if (!state) throw new Error('STATE_MISMATCH');

  return { code, state };
}
