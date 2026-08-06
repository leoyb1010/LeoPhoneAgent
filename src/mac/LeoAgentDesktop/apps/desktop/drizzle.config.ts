import type { Config } from 'drizzle-kit';

/**
 * chat-data-localization F1：drizzle-kit 配置。
 *
 * - schema 入口：`src/main/localDb/schema.ts`
 * - 输出目录：`drizzle/`（与 forge.config.ts 的 extraResource 对齐——packaged 后通过 process.resourcesPath/drizzle 加载）
 * - dialect：sqlite（main 进程独占 better-sqlite3）
 *
 * 生成命令：`pnpm db:generate` / 校验：`pnpm db:check`
 */
export default {
  schema: './src/main/localDb/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
} satisfies Config;
