import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

type WorkletProcessorConstructor = new () => {
  port: {
    onmessage: ((event: { data?: unknown }) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
  };
  carry: number;
  process: (inputs: Float32Array[][]) => boolean;
  resample: (input: Float32Array, fromRate: number, toRate: number) => number[];
};

function loadProcessor(): WorkletProcessorConstructor {
  let processorClass: WorkletProcessorConstructor | undefined;
  class AudioWorkletProcessor {
    port = {
      onmessage: null,
      postMessage: vi.fn(),
    };
  }

  const context = vm.createContext({
    AudioWorkletProcessor,
    currentTime: 0,
    performance: { now: () => 0 },
    registerProcessor: (_name: string, processor: WorkletProcessorConstructor) => {
      processorClass = processor;
    },
    sampleRate: 48_000,
  });
  vm.runInContext(
    readFileSync(join(process.cwd(), 'src/renderer/voice-input/pcm16k-worklet.js'), 'utf8'),
    context,
  );
  if (!processorClass) throw new Error('PCM16k worklet processor was not registered.');
  return processorClass;
}

describe('PCM16k worklet', () => {
  it('resamples and posts pcm16k frames while active', () => {
    const Processor = loadProcessor();
    const processor = new Processor();
    const resample = vi.spyOn(processor, 'resample');

    processor.port.onmessage?.({
      data: { type: 'config', targetSampleRate: 16_000, chunkMs: 10, timeOriginMs: 0 },
    });

    expect(processor.process([[new Float32Array(480).fill(0.5)]])).toBe(true);
    expect(resample).toHaveBeenCalledTimes(1);
    expect(processor.port.postMessage).toHaveBeenCalledTimes(1);
    const [message, transfer] = processor.port.postMessage.mock.calls[0];
    expect(message).toMatchObject({
      type: 'pcm16k',
      trace: { chunkIndex: 0, sampleRate: 16_000, durationMs: 10 },
    });
    expect(message.pcm16k).toBe(transfer[0]);
  });

  it('does not resample input while inactive', () => {
    const Processor = loadProcessor();
    const processor = new Processor();
    const resample = vi.spyOn(processor, 'resample');

    processor.port.onmessage?.({
      data: { type: 'setActive', active: false, reset: true },
    });

    expect(processor.process([[new Float32Array(128)]])).toBe(true);
    expect(resample).not.toHaveBeenCalled();
  });

  it('resets resampler carry when toggling active state with reset', () => {
    const Processor = loadProcessor();
    const processor = new Processor();

    processor.resample(new Float32Array(128), 48_000, 16_000);
    expect(processor.carry).not.toBe(0);

    processor.port.onmessage?.({
      data: { type: 'setActive', active: false, reset: true },
    });

    expect(processor.carry).toBe(0);
  });
});
