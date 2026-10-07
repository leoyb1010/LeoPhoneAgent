import { sql, type SQL } from "drizzle-orm";

type SqlExecutor = { execute: (query: SQL) => Promise<unknown> };

/**
 * LeoPhoneAgent：上游删除组织时只按固定清单删子表，清单之外仍引用 company_id 且无级联的表
 * （budget_policies、labels、environments 等）会让 DELETE /companies/:id 以 500 失败。
 * 这里在同一事务内按 information_schema 枚举所有带 company_id 列的基础表，用 savepoint 逐表删除；
 * 被外键挡住的表留到下一轮，直到全部删除或没有进展（此时由调用方抛出带表名的错误）。
 */
export async function deleteRemainingCompanyRows(
  tx: SqlExecutor,
  companyId: string,
  options: { maxPasses?: number } = {},
): Promise<{ deleted: Record<string, number>; unresolved: string[] }> {
  const tableRows = (await tx.execute(sql`
    select c.table_name as table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema = current_schema() and c.column_name = 'company_id' and c.table_name <> 'companies'
    order by c.table_name
  `)) as Array<{ table_name: string }> | { rows?: Array<{ table_name: string }> };
  const tables = (Array.isArray(tableRows) ? tableRows : tableRows.rows ?? [])
    .map((row) => row.table_name)
    .filter((name) => /^[a-z_][a-z0-9_]*$/.test(name));
  const deleted: Record<string, number> = {};
  let pending = tables;
  const maxPasses = options.maxPasses ?? Math.max(4, tables.length);
  for (let pass = 0; pass < maxPasses && pending.length > 0; pass += 1) {
    const next: string[] = [];
    for (const table of pending) {
      await tx.execute(sql`savepoint leophone_company_sweep`);
      try {
        const result = (await tx.execute(
          sql`delete from ${sql.identifier(table)} where company_id = ${companyId}`,
        )) as { count?: number; rowCount?: number } | unknown[];
        const count = Array.isArray(result) ? (result as { count?: number }).count ?? 0 : result.count ?? result.rowCount ?? 0;
        if (count > 0) deleted[table] = count;
        await tx.execute(sql`release savepoint leophone_company_sweep`);
      } catch {
        await tx.execute(sql`rollback to savepoint leophone_company_sweep`);
        next.push(table);
      }
    }
    if (next.length === pending.length) {
      pending = next;
      break;
    }
    pending = next;
  }
  return { deleted, unresolved: pending };
}
