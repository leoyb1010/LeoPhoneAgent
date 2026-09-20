import { sessionIsBusyToHalt } from './session-halt';

export function canAbortTurn(machine?: string | null, status?: string | null): boolean {
  return machine === 'local' && sessionIsBusyToHalt(status);
}

export function abortTurnLabel(): string {
  return '停这一轮';
}

export function abortTurnToast(): string {
  return '已停这一轮，会话还在';
}
