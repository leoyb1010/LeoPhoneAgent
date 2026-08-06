/**
 * feishu/events.ts
 * ---------------------------------------------------------------------------
 * Module-internal event bus for the feishu channel. Status / conflict events
 * are mirrored to the IPC bridge by `ipc.ts`; the message / cardAction events
 * are exposed to the host via `FeishuIM.onMessage` / `.onCardAction`.
 */

import { EventEmitter } from 'node:events';

import type {
  IMCardActionEvent,
  IMMessageEvent,
  IMStatus,
} from '../types.js';
import type { FeishuStatusUpdate } from './internal-types.js';

interface FeishuChannelEvents {
  // Internal status (broadcast to renderer via IPC).
  status: (update: FeishuStatusUpdate) => void;
  conflict: (payload: { appId: string }) => void;
  // Public IM events (consumed by host orchestrator via FeishuIM API).
  message: (event: IMMessageEvent) => void;
  cardAction: (event: IMCardActionEvent) => void;
  imStatus: (status: IMStatus) => void;
}

class FeishuEventBus extends EventEmitter {
  override on<K extends keyof FeishuChannelEvents>(
    event: K,
    listener: FeishuChannelEvents[K],
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override off<K extends keyof FeishuChannelEvents>(
    event: K,
    listener: FeishuChannelEvents[K],
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof FeishuChannelEvents>(
    event: K,
    ...args: Parameters<FeishuChannelEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}

export const feishuEvents = new FeishuEventBus();
