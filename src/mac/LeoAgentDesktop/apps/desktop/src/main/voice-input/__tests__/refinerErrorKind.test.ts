import { describe, expect, it } from 'vitest';

import {
  describeErrorWithCause,
  isRefinerModelOutputError,
  markRefinerModelOutputError,
} from '../refinerErrorKind.js';

describe('refinerErrorKind', () => {
  it('marks Error instances in place', () => {
    const error = new Error('Invalid JSON response');
    const marked = markRefinerModelOutputError(error);
    expect(marked).toBe(error);
    expect(isRefinerModelOutputError(marked)).toBe(true);
  });

  it('wraps non-object throw values so the flag is never silently dropped', () => {
    const marked = markRefinerModelOutputError('string throw from downstream lib');
    expect(marked).toBeInstanceOf(Error);
    expect((marked as Error).message).toContain('string throw from downstream lib');
    expect(isRefinerModelOutputError(marked)).toBe(true);
  });

  it('treats unmarked errors as transport by default', () => {
    expect(isRefinerModelOutputError(new Error('HTTP 502'))).toBe(false);
    expect(isRefinerModelOutputError('plain string')).toBe(false);
    expect(isRefinerModelOutputError(undefined)).toBe(false);
  });
});

describe('describeErrorWithCause', () => {
  it('keeps plain error messages unchanged', () => {
    expect(describeErrorWithCause(new Error('HTTP 502'))).toBe('HTTP 502');
    expect(describeErrorWithCause('plain string')).toBe('plain string');
  });

  it('surfaces the undici fetch-failed cause whose detail lives only in code', () => {
    // Mirrors undici's shape on network failure: TypeError('fetch failed')
    // wrapping an Error with an empty message and only `code` set.
    const cause = new Error('') as NodeJS.ErrnoException;
    cause.code = 'ETIMEDOUT';
    const error = new TypeError('fetch failed', { cause });
    expect(describeErrorWithCause(error)).toBe('fetch failed <- ETIMEDOUT');
  });

  it('appends codes to non-empty cause messages and walks nested causes', () => {
    const inner = new Error('connect ECONNREFUSED 2606:4700::1:443') as NodeJS.ErrnoException;
    inner.code = 'ECONNREFUSED';
    const middle = new Error('Connect Timeout Error', { cause: inner }) as NodeJS.ErrnoException;
    middle.code = 'UND_ERR_CONNECT_TIMEOUT';
    const outer = new TypeError('fetch failed', { cause: middle });
    expect(describeErrorWithCause(outer)).toBe(
      'fetch failed <- Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT) <- connect ECONNREFUSED 2606:4700::1:443',
    );
  });

  it('stringifies non-error causes and bounds the cause chain depth', () => {
    expect(describeErrorWithCause(new Error('outer', { cause: 'raw detail' }))).toBe('outer <- raw detail');
    const deep = new Error('L4');
    const chained = new Error('L0', {
      cause: new Error('L1', { cause: new Error('L2', { cause: new Error('L3', { cause: deep }) }) }),
    });
    expect(describeErrorWithCause(chained)).toBe('L0 <- L1 <- L2 <- L3');
  });
});
