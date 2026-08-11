import { logger } from '@/modules/logging/index.js';
import { getConnection } from "@/modules/database/connection.js";
import { runMigrations } from "@/modules/database/migrations.js";
import { INIT_SCHEMA_SQL } from "@/modules/database/schema.js";

// Initialize database with schema
export const initializeDatabase = async () => {
    try {
        const db = getConnection();
        db.exec(INIT_SCHEMA_SQL);
        logger.info('Database schema applied');
        runMigrations(db);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.info('Database initialization failed', { error: message });
        throw err;
    }
};
