import type { FlowRow } from './model';

export function sessionTurnCount(rows?: readonly FlowRow[] | null): number {
  if (!rows?.length) return 0;
  return rows.filter((row) => row.k === 'user' && (row.mode ?? 'prompt') === 'prompt').length;
}

export function sessionAgeSeconds(createdAt?: number | null, nowSec = Date.now() / 1000): number {
  if (!createdAt || createdAt <= 0) return 0;
  return Math.max(0, nowSec - createdAt);
}

export function sessionAgeLabel(seconds: number): string {
  const sec = Math.max(0, seconds);
  if (sec < 45) return '不到 1 分钟';
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} 分钟`;
  if (sec < 86400 * 2) return `${Math.round(sec / 3600)} 小时`;
  return `${Math.round(sec / 86400)} 天`;
}

export function sessionPulseLabel(input: {
  rows?: readonly FlowRow[] | null;
  createdAt?: number | null;
  nowSec?: number;
}): string {
  const turns = sessionTurnCount(input.rows);
  const age = sessionAgeSeconds(input.createdAt, input.nowSec);
  const parts: string[] = [];
  if (turns > 0) parts.push(`${turns} 轮`);
  if (age > 0) parts.push(sessionAgeLabel(age));
  return parts.join(' · ');
}

export function canShowSessionPulse(machine?: string | null, rows?: readonly FlowRow[] | null, createdAt?: number | null): boolean {
  return machine === 'local' && (sessionTurnCount(rows) > 0 || sessionAgeSeconds(createdAt) > 0);
}

export function sessionPulseToast(label: string): string {
  const next = label.trim();
  return next ? `这条 ${next}` : '这条还没开始聊';
}
