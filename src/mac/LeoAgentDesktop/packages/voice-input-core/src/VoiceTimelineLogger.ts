import type { VoiceTimelineEvent } from './types';

export type VoiceTimelineSink = (event: VoiceTimelineEvent) => void;

/**
 * VoiceTimelineLogger records every user-visible voice-input transition.
 *
 * The core package keeps only an in-memory copy and calls the injected sink.
 * Hosts decide where logs go; desktop injects its unified logger instead of
 * letting package code write to console.
 */
export class VoiceTimelineLogger {
  private events: VoiceTimelineEvent[] = [];
  private readonly sink?: VoiceTimelineSink;

  constructor(sink?: VoiceTimelineSink) {
    this.sink = sink;
  }

  record(event: VoiceTimelineEvent): void {
    this.events.push(event);
    this.sink?.(event);
  }

  all(): VoiceTimelineEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }

  exportJson(): string {
    return JSON.stringify(this.events, null, 2);
  }

  eventsForRun(runId: string): VoiceTimelineEvent[] {
    return this.events.filter((event) => event.runId === runId);
  }
}
