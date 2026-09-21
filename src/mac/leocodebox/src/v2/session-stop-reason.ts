/** 官方 stopReason=aborted 是中途停，不能当成说完。 */

export function sessionAbortedStop(stopReason?: string | null): boolean {
  return String(stopReason ?? '').trim().toLowerCase() === 'aborted';
}

export function sessionAbortedStopLabel(stopReason?: string | null): string {
  return sessionAbortedStop(stopReason) ? '中途停了' : '';
}
