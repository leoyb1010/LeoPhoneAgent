import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TextModelClient } from '@cindy/voice-input-core';

import {
  FallbackTextModelClient,
  type FallbackTextModelAttempt,
} from '../FallbackTextModelClient.js';
import { markRefinerModelOutputError } from '../refinerErrorKind.js';
import { resetVoiceInputProviderHealthForTests } from '../VoiceInputProviderHealth.js';
import type { VoiceInputRefinerProviderKind } from '../../../shared/voiceInputRefinerProfiles.js';

type RequestInput = Parameters<TextModelClient['requestJson']>[0];

function makeAttempt(
  profileId: string,
  behavior: (input: RequestInput) => Promise<unknown>,
  promptCacheScope?: string,
): FallbackTextModelAttempt & { requestJson: ReturnType<typeof vi.fn> } {
  const requestJson = vi.fn(behavior);
  return {
    profileId: profileId as VoiceInputRefinerProviderKind,
    model: `${profileId}-model`,
    client: { requestJson } as unknown as TextModelClient,
    promptCacheScope,
    requestJson,
  };
}

const baseInput: RequestInput = {
  model: 'caller-model',
  system: 'system prompt',
  user: { dictationText: 'hi' },
  schemaName: 'dictation_refinement',
};

describe('FallbackTextModelClient', () => {
  beforeEach(() => {
    resetVoiceInputProviderHealthForTests();
  });

  it('returns the first attempt result and overrides model + cache scope per attempt', async () => {
    const first = makeAttempt('codex-gpt-5.4-mini', async () => ({ text: 'ok' }), 'scope:codex');
    const second = makeAttempt('litellm-gpt-5.4-mini', async () => ({ text: 'backup' }));
    const client = new FallbackTextModelClient([first, second]);

    const result = await client.requestJson<{ text: string }>({ ...baseInput, promptCacheScope: 'caller-scope' });

    expect(result).toEqual({ text: 'ok' });
    expect(second.requestJson).not.toHaveBeenCalled();
    const sent = first.requestJson.mock.calls[0][0] as RequestInput;
    expect(sent.model).toBe('codex-gpt-5.4-mini-model');
    expect(sent.promptCacheScope).toBe('scope:codex');
  });

  it('lets a caller-supplied scope flow through when the attempt has no per-profile scope', async () => {
    const first = makeAttempt('codex-gpt-5.4-mini', async () => ({ text: 'ok' }));
    const client = new FallbackTextModelClient([first]);

    await client.requestJson({ ...baseInput, promptCacheScope: 'caller-scope' });

    expect((first.requestJson.mock.calls[0][0] as RequestInput).promptCacheScope).toBe('caller-scope');
  });

  it('falls back to the next attempt on a transport failure before any partial output', async () => {
    const first = makeAttempt('codex-gpt-5.4-mini', async () => {
      throw new Error('timed out while waiting for response headers');
    });
    const second = makeAttempt('litellm-gpt-5.4-mini', async () => ({ text: 'backup' }));
    const client = new FallbackTextModelClient([first, second]);

    const result = await client.requestJson<{ text: string }>({ ...baseInput });

    expect(result).toEqual({ text: 'backup' });
    expect(first.requestJson).toHaveBeenCalledTimes(1);
    expect(second.requestJson).toHaveBeenCalledTimes(1);
  });

  it('does not fall back once the failing attempt already streamed partial output', async () => {
    const first = makeAttempt('codex-gpt-5.4-mini', async (input) => {
      input.onTextSnapshot?.('partial text already shown');
      throw new Error('stream died mid-flight');
    });
    const second = makeAttempt('litellm-gpt-5.4-mini', async () => ({ text: 'backup' }));
    const client = new FallbackTextModelClient([first, second]);

    const snapshots: string[] = [];
    await expect(
      client.requestJson({ ...baseInput, onTextSnapshot: (text) => snapshots.push(text) }),
    ).rejects.toThrow('stream died mid-flight');

    expect(snapshots).toEqual(['partial text already shown']);
    expect(second.requestJson).not.toHaveBeenCalled();
  });

  it('caps fallback at two attempts even when the chain is longer', async () => {
    const fail = async (): Promise<unknown> => {
      throw new Error('down');
    };
    const first = makeAttempt('codex-gpt-5.4-mini', fail);
    const second = makeAttempt('litellm-gpt-5.4-mini', fail);
    const third = makeAttempt('litellm-deepseek-v4-flash', async () => ({ text: 'never reached' }));
    const client = new FallbackTextModelClient([first, second, third]);

    await expect(client.requestJson({ ...baseInput })).rejects.toThrow('down');
    expect(third.requestJson).not.toHaveBeenCalled();
  });

  it('model-output errors fall back to the next model WITHOUT putting the provider into cooldown', async () => {
    let firstBroken = true;
    const first = makeAttempt('codex-gpt-5.4-mini', async () => {
      if (firstBroken) {
        throw markRefinerModelOutputError(new Error('Invalid JSON response: garbage'));
      }
      return { text: 'primary ok' };
    });
    const second = makeAttempt('litellm-gpt-5.4-mini', async () => ({ text: 'backup' }));
    const client = new FallbackTextModelClient([first, second]);

    // First request: bad generation on the primary → rescued by the backup.
    await expect(client.requestJson<{ text: string }>({ ...baseInput })).resolves.toEqual({ text: 'backup' });
    expect(first.requestJson).toHaveBeenCalledTimes(1);
    expect(second.requestJson).toHaveBeenCalledTimes(1);

    // Second request: NO cooldown was recorded, so the primary stays first
    // (unlike a transport failure, which would demote it behind the backup).
    firstBroken = false;
    await expect(client.requestJson<{ text: string }>({ ...baseInput })).resolves.toEqual({ text: 'primary ok' });
    expect(first.requestJson).toHaveBeenCalledTimes(2);
    expect(second.requestJson).toHaveBeenCalledTimes(1);
  });

  it('orders the next request behind sticky failover: a failed provider sorts after healthy ones', async () => {
    let firstHealthy = false;
    const first = makeAttempt('codex-gpt-5.4-mini', async () => {
      if (!firstHealthy) throw new Error('cold start failure');
      return { text: 'primary back' };
    });
    const second = makeAttempt('litellm-gpt-5.4-mini', async () => ({ text: 'backup' }));
    const client = new FallbackTextModelClient([first, second]);

    await client.requestJson({ ...baseInput });
    expect(first.requestJson).toHaveBeenCalledTimes(1);
    expect(second.requestJson).toHaveBeenCalledTimes(1);

    // Second dictation: the cooled-down primary must not cost another
    // idle-timeout wait — the healthy backup goes first.
    firstHealthy = true;
    const result = await client.requestJson<{ text: string }>({ ...baseInput });
    expect(result).toEqual({ text: 'backup' });
    expect(first.requestJson).toHaveBeenCalledTimes(1);
    expect(second.requestJson).toHaveBeenCalledTimes(2);
  });
});
