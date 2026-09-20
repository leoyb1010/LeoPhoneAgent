/** 这一轮已经停了，还在转的命令行要收住，不能一直运行中。 */

export function sessionToolNeedsSettle(row?: { k?: string; running?: boolean } | null): boolean {
  return (row?.k === 'tool' || row?.k === 'edit') && row.running === true;
}

export function sessionToolSettleRows<T extends { k: string; running?: boolean; error?: boolean }>(
  rows: T[],
  error = false,
): T[] {
  let changed = false;
  const next = rows.map((row) => {
    if (!sessionToolNeedsSettle(row)) return row;
    changed = true;
    return { ...row, running: false, error: error || Boolean(row.error) };
  });
  return changed ? next : rows;
}
