/**
 * Codex system prompt injection helpers.
 *
 * This module is intentionally host-agnostic: it only maps a request thread id
 * to a pre-composed instructions blob and appends that blob to the Responses
 * top-level `instructions` field.
 */

import type { ProxyLogger, RequestTransform } from './types.js';

export interface InstructionsRegistry {
  set(threadId: string, text: string): void;
  get(threadId: string): string | undefined;
  delete(threadId: string): void;
  readonly size: number;
}

export interface InstructionsInjectionTransformOptions {
  registry: InstructionsRegistry;
  headerNames?: readonly string[];
  pathMatch?: (url: string) => boolean;
  logger?: ProxyLogger;
}

interface InjectionLogContext extends Record<string, unknown> {
  event: 'codex_proxy_injection';
  selectedHeaderName: string | null;
  selectedThreadId: string | null;
  registryHit: boolean;
  instructionsBeforeBytes: number;
  instructionsAfterBytes: number;
  inputDeveloperCount: number;
  appended: boolean;
  alreadyPresent: boolean;
}

const DEFAULT_HEADER_NAMES = ['thread-id', 'x-client-request-id'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function textBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function countInputDeveloperMessages(body: unknown): number {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return 0;
  let count = 0;
  for (const item of body.input) {
    if (isPlainObject(item) && item.role === 'developer') count += 1;
  }
  return count;
}

function instructionsText(body: unknown): string {
  if (!isPlainObject(body) || typeof body.instructions !== 'string') return '';
  return body.instructions;
}

function findHeader(
  headers: Readonly<Record<string, string>>,
  headerNames: readonly string[],
): { name: string; value: string } | null {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    normalized.set(key.toLowerCase(), value);
  }
  for (const name of headerNames) {
    const value = normalized.get(name.toLowerCase())?.trim();
    if (value) return { name, value };
  }
  return null;
}

function logInjection(logger: ProxyLogger | undefined, ctx: InjectionLogContext): void {
  logger?.debug?.('codex proxy instructions injection', ctx);
}

/**
 * Create an isolated registry. The desktop host owns the singleton instance;
 * the package only exposes this factory to avoid cross-host shared state.
 */
export function createInstructionsRegistry(): InstructionsRegistry {
  const map = new Map<string, string>();
  return {
    set(threadId, text) {
      map.set(threadId, text);
    },
    get(threadId) {
      return map.get(threadId);
    },
    delete(threadId) {
      map.delete(threadId);
    },
    get size() {
      return map.size;
    },
  };
}

/**
 * Build the structured debug-log context for a single injection decision.
 * Every branch logs the same field set; only a few values differ — keeping the
 * shape in one place avoids the 5 copy-pasted literals drifting apart.
 */
function buildInjectionLog(params: {
  selected: { name: string; value: string } | null;
  registryHit: boolean;
  beforeBytes: number;
  afterBytes: number;
  inputDeveloperCount: number;
  appended: boolean;
  alreadyPresent: boolean;
}): InjectionLogContext {
  return {
    event: 'codex_proxy_injection',
    selectedHeaderName: params.selected?.name ?? null,
    selectedThreadId: params.selected?.value ?? null,
    registryHit: params.registryHit,
    instructionsBeforeBytes: params.beforeBytes,
    instructionsAfterBytes: params.afterBytes,
    inputDeveloperCount: params.inputDeveloperCount,
    appended: params.appended,
    alreadyPresent: params.alreadyPresent,
  };
}

export function createInstructionsInjectionTransform(
  opts: InstructionsInjectionTransformOptions,
): RequestTransform {
  const headerNames = opts.headerNames ?? DEFAULT_HEADER_NAMES;
  const pathMatch = opts.pathMatch ?? ((url: string) => {
    const pathname = new URL(url, 'http://127.0.0.1').pathname.replace(/\/+$/, '');
    return pathname.endsWith('/responses');
  });

  return (body, ctx) => {
    if (!pathMatch(ctx.url)) return null;

    const inputDeveloperCount = countInputDeveloperMessages(body);
    const before = instructionsText(body);
    const beforeBytes = textBytes(before);
    const selected = findHeader(ctx.headers, headerNames);

    // No usable thread-id header → can't key the registry. Never fall back to a
    // "last/only" entry (that would cross-contaminate sessions); just skip.
    if (!selected) {
      logInjection(opts.logger, buildInjectionLog({
        selected: null, registryHit: false, beforeBytes, afterBytes: beforeBytes,
        inputDeveloperCount, appended: false, alreadyPresent: false,
      }));
      return null;
    }

    // Registry miss → this thread has no product prompt registered (non-product
    // session, or not yet registered). Skip, no fallback.
    const productInstructions = opts.registry.get(selected.value);
    if (productInstructions === undefined) {
      logInjection(opts.logger, buildInjectionLog({
        selected, registryHit: false, beforeBytes, afterBytes: beforeBytes,
        inputDeveloperCount, appended: false, alreadyPresent: false,
      }));
      return null;
    }

    // Registry hit. A hit-then-failure is a P0 signal, so emit a structured
    // error (never a silent passthrough) and skip — the proxy server layer is
    // the ultimate crash net for anything unexpected.
    const emitInjectionError = (err: string): void => {
      const logCtx = buildInjectionLog({
        selected, registryHit: true, beforeBytes, afterBytes: beforeBytes,
        inputDeveloperCount, appended: false, alreadyPresent: false,
      });
      logInjection(opts.logger, logCtx);
      opts.logger?.error?.('codex proxy instructions injection failed', {
        ...logCtx,
        event: 'codex_proxy_injection_error',
        err,
      });
    };
    if (!isPlainObject(body)) {
      emitInjectionError('responses body is not a plain object');
      return null;
    }
    if (typeof body.instructions !== 'string' && body.instructions !== undefined) {
      emitInjectionError('responses body instructions field is not a string');
      return null;
    }

    // Idempotent: never append twice.
    if (before.includes(productInstructions)) {
      logInjection(opts.logger, buildInjectionLog({
        selected, registryHit: true, beforeBytes, afterBytes: beforeBytes,
        inputDeveloperCount, appended: false, alreadyPresent: true,
      }));
      return null;
    }

    // Append after the existing codex base instructions — never replace.
    const nextInstructions = before ? `${before}\n\n${productInstructions}` : productInstructions;
    logInjection(opts.logger, buildInjectionLog({
      selected, registryHit: true, beforeBytes, afterBytes: textBytes(nextInstructions),
      inputDeveloperCount, appended: true, alreadyPresent: false,
    }));
    return { ...body, instructions: nextInstructions };
  };
}
