export function buildRecentTrendRows(points: SkillUsageTrendPoint[], anchorDay: string): SkillUsageTrendPoint[] {
  const byDay = new Map(points.map((point) => [point.day, point]));
  const rows: SkillUsageTrendPoint[] = [];
  const anchor = parseLocalDayKey(anchorDay);
  for (let offset = 29; offset >= 0; offset -= 1) {
    const date = new Date(anchor);
    date.setDate(anchor.getDate() - offset);
    const day = formatLocalDayKey(date);
    rows.push(byDay.get(day) ?? {
      day,
      useCount: 0,
      averageToolCalls: 0,
      averageRepeatedToolCalls: 0,
      commandFailureRate: null,
    });
  }
  return rows;
}

export function formatLocalDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLocalDayKey(dayKey: string): Date {
  const [year, month, day] = dayKey.split('-').map((part) => Number.parseInt(part, 10));
  return new Date(year, month - 1, day);
}
