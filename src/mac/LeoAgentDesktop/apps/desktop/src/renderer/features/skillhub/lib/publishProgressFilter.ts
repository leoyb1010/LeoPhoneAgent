export function shouldHandlePublishProgressEvent(
  event: object & { name?: unknown },
  activeName: string | null,
): boolean {
  if (!activeName) return false;
  const eventName = typeof event.name === 'string' && event.name.length > 0
    ? event.name
    : null;
  return eventName === null || eventName === activeName;
}
