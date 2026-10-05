/**
 * 发行层 1.1.6：子进程环境的服务器私密变量剔除。
 *
 * 原因：原生 CLI 状态探测、网页授权 PTY 与智能体执行都以服务器 process.env 为基础派生子进程，
 * 数据库连接串、认证签名密钥、主密钥等会进入第三方 CLI 及其可执行任意命令的智能体。
 * 选择"剔除私密"而不是白名单：CLI 依赖的代理、各 CLI 自身 HOME/配置及未知变量需原样保留。
 *
 * 只剔除与 inheritedEnv（服务器自身环境）取值相同、即"继承来"的私密变量；智能体配置或运行时
 * 显式注入的不同取值（例如每次运行签发的 PAPERCLIP_API_KEY）保留，语义与上游
 * sanitizeRemoteExecutionEnv 的"继承值才剔除"一致。
 *
 * 清单依据固定上游 994d6ed 的 server/src、packages/db 中实际读取的变量（config.ts、auth、
 * secrets、cloud connector、tool action 签名等），并按模式覆盖同类新变量。
 */
const EXACT_PRIVATE_KEYS = new Set([
  "DATABASE_URL",
  "DATABASE_MIGRATION_URL",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_MASTER_KEY",
  "PAPERCLIP_MASTER_KEY_FILE",
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
  "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_DECISION_SIGNING_SECRET",
  "PAPERCLIP_WORKSPACE_HANDOFF_SECRET",
]);
/** libpq 连接变量（PGPASSWORD、PGHOST、PGUSER、PGPASSFILE、PGSSLKEY 等）。 */
const POSTGRES_CONNECTION_KEY = /^PG[A-Z0-9_]+$/;
/** 任何 *DATABASE_URL（含 PAPERCLIP_TEST_DATABASE_URL 等测试/迁移连接串）。 */
const DATABASE_URL_KEY = /(?:^|_)DATABASE(?:_[A-Z0-9]+)*_URL$/;
/** PAPERCLIP_/BETTER_AUTH_ 前缀且名称表明为凭据的变量。 */
const CREDENTIAL_NAME = /(?:SECRET|KEY|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL)/;

export function isServerPrivateEnvKey(key: string): boolean {
  if (EXACT_PRIVATE_KEYS.has(key)) return true;
  if (POSTGRES_CONNECTION_KEY.test(key)) return true;
  if (DATABASE_URL_KEY.test(key)) return true;
  if ((key.startsWith("PAPERCLIP_") || key.startsWith("BETTER_AUTH_")) && CREDENTIAL_NAME.test(key.slice(key.indexOf("_") + 1))) return true;
  return false;
}

/**
 * 返回新对象，不修改入参。inheritedEnv 与 env 为同一对象（或 env 直接来自服务器环境）时，
 * 全部私密变量都会被剔除。
 */
export function stripServerPrivateEnv<T extends Record<string, string | undefined>>(
  env: T,
  inheritedEnv: Record<string, string | undefined> = process.env,
): T {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (!isServerPrivateEnvKey(key)) continue;
    const value = result[key];
    if (inheritedEnv === env || value === undefined || inheritedEnv[key] === value) delete result[key];
  }
  return result;
}
