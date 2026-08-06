export type LspErrorCode =
  | 'LSP_NOT_READY'
  | 'SYMBOL_NOT_FOUND'
  | 'INVALID_POSITION'
  | 'FILE_TOO_LARGE'
  | 'LSP_TIMEOUT'
  | 'INTERNAL';

/** Structured error used by LSP tools so handlers can return stable errorCode values. */
export class LspMcpError extends Error {
  constructor(
    public readonly code: LspErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LspMcpError';
  }
}

export function classifyLspError(err: unknown): { code: LspErrorCode; message: string } {
  if (err instanceof LspMcpError) {
    return { code: err.code, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout/i.test(message)) return { code: 'LSP_TIMEOUT', message };
  if (/not found|ENOENT|spawn/i.test(message)) return { code: 'LSP_NOT_READY', message };
  return { code: 'INTERNAL', message };
}
