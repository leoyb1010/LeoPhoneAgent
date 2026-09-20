export function canQueueOnEnter(input: {
  machine?: string | null;
  status?: string | null;
  prompt?: string | null;
}): boolean {
  if (input.machine !== 'local') return false;
  const status = String(input.status ?? '');
  if (status !== 'running' && status !== 'starting') return false;
  return Boolean(String(input.prompt ?? '').trim());
}

export function queueOnEnterToast(): string {
  return '已排在后面,这轮说完再执行';
}
