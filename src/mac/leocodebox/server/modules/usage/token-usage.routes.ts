import fs, { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import express from 'express';

import { getOpenCodeDatabasePath } from '@/shared/utils.js';
import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { getModelContextWindow } from '@/modules/providers/index.js';

const router = express.Router();

type OpenCodeUsageRow = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
};

function readUsageNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

router.get('/:projectId/sessions/:sessionId/token-usage', async (req, res) => {
    try {
        const { projectId, sessionId } = req.params;
        const homeDir = os.homedir();

        // Allow only safe characters in sessionId
        const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safeSessionId || safeSessionId !== String(sessionId)) {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }

        // Provider artifacts on disk (JSONL file names, OpenCode sqlite rows)
        // are keyed by the provider-native session id, while the caller sends
        // the app-facing id. Resolve provider and id mapping from the indexed
        // session row so the frontend does not choose provider-specific paths.
        const sessionRow = sessionsDb.getSessionById(safeSessionId);
        if (!sessionRow) {
            return res.status(404).json({ error: 'Session not found', sessionId: safeSessionId });
        }

        const provider = sessionRow.provider || 'claude';
        const providerNativeSessionId = sessionRow?.provider_session_id || safeSessionId;

        // Handle Cursor sessions - they use SQLite and don't have token usage info
        if (provider === 'cursor') {
            return res.json({
                used: 0,
                total: 0,
                inputTokens: 0,
                outputTokens: 0,
                breakdown: { input: 0, output: 0 },
                unsupported: true,
                message: 'Token usage tracking not available for Cursor sessions'
            });
        }

        if (provider === 'opencode') {
            const dbPath = getOpenCodeDatabasePath();
            if (!fs.existsSync(dbPath)) {
                return res.status(404).json({ error: 'OpenCode database not found' });
            }

            const db = new Database(dbPath, { readonly: true, fileMustExist: true });
            try {
                const columns = db.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>;
                const columnNames = new Set(columns.map((column) => column.name));
                const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
                if (!requiredColumns.every((column) => columnNames.has(column))) {
                    return res.json({
                        used: 0,
                        inputTokens: 0,
                        outputTokens: 0,
                        breakdown: { input: 0, output: 0 },
                        unsupported: true,
                        message: 'Token usage tracking is not available in this OpenCode database schema'
                    });
                }

                const row = db.prepare(`
                    SELECT
                        tokens_input AS inputTokens,
                        tokens_output AS outputTokens,
                        tokens_reasoning AS reasoningTokens,
                        tokens_cache_read AS cacheReadTokens,
                        tokens_cache_write AS cacheWriteTokens
                    FROM session
                    WHERE id = ?
                `).get(providerNativeSessionId) as OpenCodeUsageRow | undefined;

                if (!row) {
                    return res.status(404).json({ error: 'OpenCode session not found', sessionId: safeSessionId });
                }

                const inputTokens = Number(row.inputTokens || 0) + Number(row.cacheReadTokens || 0);
                const outputTokens = Number(row.outputTokens || 0);
                const totalUsed = Number(row.inputTokens || 0)
                    + outputTokens
                    + Number(row.reasoningTokens || 0)
                    + Number(row.cacheReadTokens || 0)
                    + Number(row.cacheWriteTokens || 0);

                return res.json({
                    used: totalUsed,
                    inputTokens,
                    outputTokens,
                    breakdown: {
                        input: inputTokens,
                        output: outputTokens
                    }
                });
            } finally {
                db.close();
            }
        }

        // Handle Codex sessions
        if (provider === 'codex') {
            const codexSessionsDir = path.join(homeDir, '.codex', 'sessions');

            // Find the session file by searching for the session ID
            const findSessionFile = async (dir: string): Promise<string | null> => {
                try {
                    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            const found = await findSessionFile(fullPath);
                            if (found) return found;
                        } else if (entry.name.includes(providerNativeSessionId) && entry.name.endsWith('.jsonl')) {
                            return fullPath;
                        }
                    }
                } catch (error) {
                    // Skip directories we can't read
                }
                return null;
            };

            const sessionFilePath = await findSessionFile(codexSessionsDir);

            if (!sessionFilePath) {
                return res.status(404).json({ error: 'Codex session file not found', sessionId: safeSessionId });
            }

            // Read and parse the Codex JSONL file
            let fileContent;
            try {
                fileContent = await fsPromises.readFile(sessionFilePath, 'utf8');
            } catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                    return res.status(404).json({ error: 'Session file not found', path: sessionFilePath });
                }
                throw error;
            }
            const lines = fileContent.trim().split('\n');
            let inputTokens = 0;
            let outputTokens = 0;
            let totalTokens = 0;
            let contextWindow = 200000; // Default for Codex/OpenAI

            // Find the latest token_count event with info (scan from end)
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const entry = JSON.parse(lines[i]);

                    // Codex stores token info in event_msg with type: "token_count"
                    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
                        const tokenInfo = entry.payload.info;
                        if (tokenInfo.total_token_usage) {
                            inputTokens = tokenInfo.total_token_usage.input_tokens || 0;
                            outputTokens = tokenInfo.total_token_usage.output_tokens || 0;
                            totalTokens = tokenInfo.total_token_usage.total_tokens || inputTokens + outputTokens;
                        }
                        if (tokenInfo.model_context_window) {
                            contextWindow = tokenInfo.model_context_window;
                        }
                        break; // Stop after finding the latest token count
                    }
                } catch (parseError) {
                    // Skip lines that can't be parsed
                    continue;
                }
            }

            return res.json({
                used: totalTokens,
                total: contextWindow,
                inputTokens,
                outputTokens,
                breakdown: {
                    input: inputTokens,
                    output: outputTokens
                }
            });
        }

        // Handle Claude sessions (default)
        // Resolve the project path through the DB using the caller-supplied
        // `projectId`. Legacy code here called extractProjectDirectory with a
        // folder-encoded project name; the migration centralizes that lookup
        // in the projects table.
        const projectPath = await projectsDb.getProjectPathById(projectId);
        if (!projectPath) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Construct the JSONL file path
        // Claude stores session files in ~/.claude/projects/[encoded-project-path]/[session-id].jsonl
        // The encoding replaces any non-alphanumeric character (except -) with -
        const encodedPath = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
        const projectDir = path.join(homeDir, '.claude', 'projects', encodedPath);

        // Prefer the indexed transcript path (already produced by the trusted
        // session synchronizer); fall back to the conventional location
        // derived from the provider-native session id.
        let jsonlPath: string = sessionRow?.jsonl_path || '';
        if (!jsonlPath) {
            jsonlPath = path.join(projectDir, `${providerNativeSessionId}.jsonl`);

            // Constrain the constructed path to projectDir (the id is
            // caller-influenced in this fallback branch).
            const rel = path.relative(path.resolve(projectDir), path.resolve(jsonlPath));
            if (rel.startsWith('..') || path.isAbsolute(rel)) {
                return res.status(400).json({ error: 'Invalid path' });
            }
        }

        // Read and parse the JSONL file
        let fileContent;
        try {
            fileContent = await fsPromises.readFile(jsonlPath, 'utf8');
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                return res.status(404).json({ error: 'Session file not found', path: jsonlPath });
            }
            throw error; // Re-throw other errors to be caught by outer try-catch
        }
        const lines = fileContent.trim().split('\n');

        let contextWindow = getModelContextWindow(provider);
        let modelName: string | undefined;
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheCreationTokens = 0;

        // Find the latest assistant message with usage data (scan from end)
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(lines[i]);

                // Only count assistant messages which have usage data
                if (entry.type === 'assistant' && entry.message?.usage) {
                    const usage = entry.message.usage;
                    modelName = typeof entry.message.model === 'string' ? entry.message.model : undefined;
                    contextWindow = getModelContextWindow(provider, modelName);

                    // Use token counts from latest assistant message only
                    const directInputTokens = readUsageNumber(usage.input_tokens ?? usage.inputTokens);
                    cacheReadTokens = readUsageNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens);
                    cacheCreationTokens = readUsageNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cacheCreationTokens);
                    inputTokens = directInputTokens + cacheReadTokens + cacheCreationTokens;
                    outputTokens = readUsageNumber(usage.output_tokens ?? usage.outputTokens);

                    break; // Stop after finding the latest assistant message
                }
            } catch (parseError) {
                // Skip lines that can't be parsed
                continue;
            }
        }

        const totalUsed = inputTokens + outputTokens;
        const cacheTokens = cacheReadTokens + cacheCreationTokens;

        res.json({
            used: totalUsed,
            total: contextWindow,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            cacheTokens,
            breakdown: {
                input: inputTokens,
                output: outputTokens
            }
        });
    } catch (error) {
        console.error('Error reading session token usage:', error);
        res.status(500).json({ error: 'Failed to read session token usage' });
    }
});


export default router;
