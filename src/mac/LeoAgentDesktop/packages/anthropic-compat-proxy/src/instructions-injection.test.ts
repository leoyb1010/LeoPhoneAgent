import { describe, expect, it } from 'vitest';

import {
  createInstructionsInjectionTransform,
  createInstructionsRegistry,
  type InstructionsRegistry,
} from './instructions-injection.js';
import type { ProxyLogger, RequestTransformCtx } from './types.js';

function ctx(headers: Record<string, string>, url = '/v1/responses'): RequestTransformCtx {
  return {
    reqId: 1,
    method: 'POST',
    url,
    headers,
  };
}

function makeRegistry(entries: Array<[string, string]>): InstructionsRegistry {
  const registry = createInstructionsRegistry();
  for (const [threadId, text] of entries) registry.set(threadId, text);
  return registry;
}

function makeLogger(): ProxyLogger & {
  debugEntries: Array<Record<string, unknown>>;
  errorEntries: Array<Record<string, unknown>>;
} {
  const debugEntries: Array<Record<string, unknown>> = [];
  const errorEntries: Array<Record<string, unknown>> = [];
  return {
    debugEntries,
    errorEntries,
    debug: (_msg, entry) => {
      if (entry) debugEntries.push(entry);
    },
    error: (_msg, entry) => {
      if (entry) errorEntries.push(entry);
    },
  };
}

describe('instructions injection transform', () => {
  it('appends registry instructions after existing top-level instructions', () => {
    const registry = makeRegistry([['thread-1', 'PRODUCT_PROMPT']]);
    const transform = createInstructionsInjectionTransform({ registry });
    const body = {
      model: 'gpt-5.4',
      instructions: 'BASE_PROMPT',
      input: [],
    };

    const result = transform(body, ctx({ 'thread-id': 'thread-1' }));

    expect(result).toMatchObject({
      instructions: 'BASE_PROMPT\n\nPRODUCT_PROMPT',
    });
    expect((result as { instructions: string }).instructions.indexOf('BASE_PROMPT'))
      .toBeLessThan((result as { instructions: string }).instructions.indexOf('PRODUCT_PROMPT'));
  });

  it('uses header priority and supports case-insensitive header lookup', () => {
    const registry = makeRegistry([
      ['thread-primary', 'PRIMARY_PROMPT'],
      ['thread-secondary', 'SECONDARY_PROMPT'],
    ]);
    const transform = createInstructionsInjectionTransform({ registry });

    const priorityResult = transform(
      { instructions: 'BASE', input: [] },
      ctx({
        'THREAD-ID': 'thread-primary',
        'x-client-request-id': 'thread-secondary',
      }),
    );
    expect(priorityResult).toMatchObject({
      instructions: 'BASE\n\nPRIMARY_PROMPT',
    });

    const requestIdResult = transform(
      { instructions: 'BASE', input: [] },
      ctx({ 'X-Client-Request-ID': 'thread-secondary' }),
    );
    expect(requestIdResult).toMatchObject({
      instructions: 'BASE\n\nSECONDARY_PROMPT',
    });
  });

  it('does not use session-id as a fallback registry key', () => {
    const registry = makeRegistry([['thread-session', 'SESSION_PROMPT']]);
    const transform = createInstructionsInjectionTransform({ registry });

    expect(transform(
      { instructions: 'BASE', input: [] },
      ctx({ 'Session-Id': 'thread-session' }),
    )).toBeNull();
  });

  it('is idempotent for the same body', () => {
    const registry = makeRegistry([['thread-1', 'PRODUCT_PROMPT']]);
    const transform = createInstructionsInjectionTransform({ registry });

    const first = transform({ instructions: 'BASE', input: [] }, ctx({ 'thread-id': 'thread-1' }));
    expect(first).toMatchObject({ instructions: 'BASE\n\nPRODUCT_PROMPT' });

    const second = transform(first, ctx({ 'thread-id': 'thread-1' }));
    expect(second).toBeNull();
  });

  it('does not inject on registry miss and does not use any fallback', () => {
    const registry = makeRegistry([['other-thread', 'WRONG_PROMPT']]);
    const logger = makeLogger();
    const transform = createInstructionsInjectionTransform({ registry, logger });
    const body = { instructions: 'BASE', input: [] };

    const result = transform(body, ctx({ 'thread-id': 'missing-thread' }));

    expect(result).toBeNull();
    expect(body.instructions).toBe('BASE');
    expect(logger.debugEntries.at(-1)).toMatchObject({
      event: 'codex_proxy_injection',
      selectedHeaderName: 'thread-id',
      selectedThreadId: 'missing-thread',
      registryHit: false,
      appended: false,
    });
  });

  it('injects only when pathMatch matches /responses', () => {
    const registry = makeRegistry([['thread-1', 'PRODUCT_PROMPT']]);
    const transform = createInstructionsInjectionTransform({ registry });

    const responseResult = transform(
      { instructions: 'BASE', input: [] },
      ctx({ 'thread-id': 'thread-1' }, '/v1/responses?stream=true'),
    );
    expect(responseResult).toMatchObject({ instructions: 'BASE\n\nPRODUCT_PROMPT' });

    const trailingSlashResult = transform(
      { instructions: 'BASE', input: [] },
      ctx({ 'thread-id': 'thread-1' }, '/v1/responses/'),
    );
    expect(trailingSlashResult).toMatchObject({ instructions: 'BASE\n\nPRODUCT_PROMPT' });

    const compactResult = transform(
      { instructions: 'BASE', input: [] },
      ctx({ 'thread-id': 'thread-1' }, '/v1/responses/compact'),
    );
    expect(compactResult).toBeNull();
  });

  it('logs inputDeveloperCount for validation', () => {
    const registry = makeRegistry([['thread-1', 'PRODUCT_PROMPT']]);
    const logger = makeLogger();
    const transform = createInstructionsInjectionTransform({ registry, logger });

    transform(
      {
        instructions: 'BASE',
        input: [
          { role: 'developer', content: 'dev 1' },
          { role: 'user', content: 'hello' },
          { role: 'developer', content: 'dev 2' },
        ],
      },
      ctx({ 'thread-id': 'thread-1' }),
    );

    expect(logger.debugEntries.at(-1)).toMatchObject({
      event: 'codex_proxy_injection',
      registryHit: true,
      inputDeveloperCount: 2,
      appended: true,
    });
  });

  it('logs structured errors and does not throw on injection failure', () => {
    const registry = makeRegistry([['thread-1', 'PRODUCT_PROMPT']]);
    const logger = makeLogger();
    const transform = createInstructionsInjectionTransform({ registry, logger });

    const result = transform(
      { instructions: ['not', 'a', 'string'], input: [] },
      ctx({ 'thread-id': 'thread-1' }),
    );

    expect(result).toBeNull();
    expect(logger.debugEntries.at(-1)).toMatchObject({
      event: 'codex_proxy_injection',
      selectedHeaderName: 'thread-id',
      selectedThreadId: 'thread-1',
      registryHit: true,
      appended: false,
    });
    expect(logger.errorEntries.at(-1)).toMatchObject({
      event: 'codex_proxy_injection_error',
      selectedHeaderName: 'thread-id',
      selectedThreadId: 'thread-1',
      registryHit: true,
      appended: false,
    });
  });

  it('injects as top-level instructions when the body has no instructions field', () => {
    const registry = makeRegistry([['thread-1', 'PRODUCT_PROMPT']]);
    const transform = createInstructionsInjectionTransform({ registry });

    // codex 实际总会带 instructions;这里覆盖 instructions 缺失的防御分支:
    // before 为空 → 产品 prompt 直接作为顶层 instructions(无 base 前缀、无 \n\n 分隔)。
    const result = transform({ input: [] }, ctx({ 'thread-id': 'thread-1' }));

    expect(result).toMatchObject({ instructions: 'PRODUCT_PROMPT' });
  });
});
