import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
    isPackaged: false,
  },
}));

import { resolveUtilityModelSelectionValues } from '../UtilityModelSelection.js';

describe('UtilityModelSelection', () => {
  it('uses the voice input refiner default chain by default', () => {
    const result = resolveUtilityModelSelectionValues({});

    expect(result.values).toEqual({
      provider: 'codex-gpt-5.4-mini',
      model: undefined,
      providerChain: [
        'codex-gpt-5.4-mini',
        'litellm-gpt-5.4-mini',
        'litellm-kimi-k2.6',
        'litellm-deepseek-v4-flash',
      ],
    });
    expect(result.warnings).toEqual([]);
  });

  it('keeps compatibility with existing voice input refiner config fields', () => {
    const result = resolveUtilityModelSelectionValues({
      refinerProvider: 'litellm-qwen3.6-plus',
      refinerModel: 'qwen/qwen3.6-plus',
      refinerProviderChain: ['litellm-glm-5.1', 'litellm-deepseek-v4-flash'],
    });

    expect(result.values).toEqual({
      provider: 'litellm-qwen3.6-plus',
      model: 'qwen/qwen3.6-plus',
      providerChain: [
        'litellm-qwen3.6-plus',
        'litellm-glm-5.1',
        'litellm-deepseek-v4-flash',
      ],
    });
    expect(result.warnings).toEqual([]);
  });

  it('lets utility model fields override legacy refiner fields', () => {
    const result = resolveUtilityModelSelectionValues({
      utilityModelProvider: 'litellm-kimi-k2.6',
      utilityModel: 'moonshotai/kimi-k2.6',
      utilityModelProviderChain: ['litellm-qwen3.7-max'],
      refinerProvider: 'litellm-qwen3.6-plus',
      refinerModel: 'qwen/qwen3.6-plus',
      refinerProviderChain: ['litellm-glm-5.1'],
    });

    expect(result.values).toEqual({
      provider: 'litellm-kimi-k2.6',
      model: 'moonshotai/kimi-k2.6',
      providerChain: [
        'litellm-kimi-k2.6',
        'litellm-qwen3.7-max',
      ],
    });
    expect(result.warnings).toEqual([]);
  });

  it('reads utility env vars before voice input refiner env vars', () => {
    const result = resolveUtilityModelSelectionValues(
      {},
      {
        XDT_UTILITY_MODEL_PROVIDER: 'litellm-glm-5.1',
        XDT_UTILITY_MODEL: 'z-ai/glm-5.1',
        XDT_UTILITY_MODEL_PROVIDER_CHAIN: 'litellm-kimi-k2.6',
        XDT_VOICE_INPUT_REFINER_PROVIDER: 'litellm-qwen3.6-plus',
        XDT_VOICE_INPUT_REFINER_MODEL: 'qwen/qwen3.6-plus',
        XDT_VOICE_INPUT_REFINER_PROVIDER_CHAIN: 'litellm-deepseek-v4-flash',
      },
    );

    expect(result.values).toEqual({
      provider: 'litellm-glm-5.1',
      model: 'z-ai/glm-5.1',
      providerChain: [
        'litellm-glm-5.1',
        'litellm-kimi-k2.6',
      ],
    });
  });

  it('reads utility env vars before legacy refiner config fields', () => {
    const result = resolveUtilityModelSelectionValues(
      {
        refinerProvider: 'litellm-qwen3.6-plus',
        refinerModel: 'qwen/qwen3.6-plus',
        refinerProviderChain: ['litellm-deepseek-v4-flash'],
      },
      {
        XDT_UTILITY_MODEL_PROVIDER: 'litellm-glm-5.1',
        XDT_UTILITY_MODEL: 'z-ai/glm-5.1',
        XDT_UTILITY_MODEL_PROVIDER_CHAIN: 'litellm-kimi-k2.6',
      },
    );

    expect(result.values).toEqual({
      provider: 'litellm-glm-5.1',
      model: 'z-ai/glm-5.1',
      providerChain: [
        'litellm-glm-5.1',
        'litellm-kimi-k2.6',
      ],
    });
  });

  it('drops unknown chain entries with warnings', () => {
    const result = resolveUtilityModelSelectionValues({
      utilityModelProviderChain: ['unknown-a', 'unknown-b'],
    });

    expect(result.values.providerChain).toEqual([
      'codex-gpt-5.4-mini',
      'litellm-gpt-5.4-mini',
      'litellm-kimi-k2.6',
      'litellm-deepseek-v4-flash',
    ]);
    expect(result.warnings).toEqual([
      { field: 'providerChain', value: 'unknown-a', fallback: '<dropped>' },
      { field: 'providerChain', value: 'unknown-b', fallback: '<dropped>' },
    ]);
  });
});
