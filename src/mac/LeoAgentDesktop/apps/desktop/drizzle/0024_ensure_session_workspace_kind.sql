-- Repair migration for dev/user DBs whose migration_meta reached 22 before
-- 0022_session_workspace_kind actually added the physical column.
-- The idempotent work lives in scripts/0023_ensure_session_workspace_kind.ts.
SELECT 1;
