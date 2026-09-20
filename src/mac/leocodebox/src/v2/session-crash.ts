export function lastAbruptToast(): string {
  return '上次异常退出了。';
}

export function lastRunWasAbrupt(row?: { abrupt?: boolean } | null): boolean {
  return row?.abrupt === true;
}
