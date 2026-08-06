import * as Crypto from 'expo-crypto';

export async function createPkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = base64UrlFromBytes(Crypto.getRandomBytes(32));
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    codeVerifier,
    { encoding: Crypto.CryptoEncoding.BASE64 },
  );
  return {
    codeVerifier,
    codeChallenge: toBase64Url(digest),
  };
}

export function createState(): string {
  const cryptoWithUuid = Crypto as typeof Crypto & { randomUUID?: () => string };
  if (typeof cryptoWithUuid.randomUUID === 'function') return cryptoWithUuid.randomUUID();
  return base64UrlFromBytes(Crypto.getRandomBytes(24));
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  return toBase64Url(base64FromBytes(bytes));
}

function toBase64Url(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64FromBytes(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    out += alphabet[(triple >> 18) & 63];
    out += alphabet[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? alphabet[triple & 63] : '=';
  }
  return out;
}
