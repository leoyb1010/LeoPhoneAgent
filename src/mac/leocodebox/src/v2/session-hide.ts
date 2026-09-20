import type { FlowRow } from './model';

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[posru]_[A-Za-z0-9]{30,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
];

export const HIDDEN_SECRET = '••••';

export function hideSecrets(raw?: string | null): string {
  let text = String(raw ?? '');
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, HIDDEN_SECRET);
  }
  return text;
}

export function textHasSecrets(raw?: string | null): boolean {
  const text = String(raw ?? '');
  if (!text) return false;
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function rowSecretText(row: FlowRow): string {
  if (row.k === 'user' || row.k === 'ai' || row.k === 'sys' || row.k === 'think') return row.text;
  if (row.k === 'tool') return `${row.preview || row.tool}\n${row.output ?? ''}`;
  if (row.k === 'edit') return row.file;
  return '';
}

export function sessionHasSecrets(rows?: readonly FlowRow[] | null): boolean {
  return Boolean(rows?.some((row) => textHasSecrets(rowSecretText(row))));
}

export function canHideSecrets(machine?: string | null, rows?: readonly FlowRow[] | null): boolean {
  return machine === 'local' && sessionHasSecrets(rows);
}

export function hideSecretsToast(on: boolean): string {
  return on ? '已藏住密钥' : '已显示密钥';
}
