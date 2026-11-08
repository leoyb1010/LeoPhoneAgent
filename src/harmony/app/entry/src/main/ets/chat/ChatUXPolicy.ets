export class FollowState {
  following: boolean = true;
  distance: number = 0;
  unread: number = 0;
}
export function userScroll(previous: FollowState, delta: number, atEnd: boolean): FollowState {
  const next = new FollowState();
  next.following = atEnd;
  next.distance = atEnd ? 0 : Math.max(0, previous.distance - delta);
  next.unread = atEnd ? 0 : previous.unread;
  return next;
}
export function incoming(previous: FollowState, count: number): FollowState {
  const next = new FollowState(); next.following = previous.following; next.distance = previous.distance;
  next.unread = previous.following ? 0 : previous.unread + Math.max(0, count);
  return next;
}
/** Bounded chunks preserve every code point, including empty/newline-only content. */
export function textPages(text: string, budget: number = 1400): string[] {
  if (!Number.isFinite(budget) || budget < 1) throw new Error('分页大小无效');
  const points = Array.from(text); const pages: string[] = [];
  for (let index = 0; index < points.length; index += Math.floor(budget)) pages.push(points.slice(index, index + Math.floor(budget)).join(''));
  return pages.length ? pages : [''];
}
export function previewBudget(width: number, height: number): number {
  // Conservative CJK estimate; the actual preview also has a 1.5-screen height cap.
  return Math.max(200, Math.floor(Math.max(200, width - 32) / 17) * Math.floor(Math.max(240, height) * 1.5 / 26));
}
