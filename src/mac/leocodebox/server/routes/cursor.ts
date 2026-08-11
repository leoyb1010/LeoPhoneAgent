import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import express from 'express';

import { logger } from '@/modules/logging/index.js';

import { CURSOR_FALLBACK_MODELS } from '../modules/providers/list/cursor/cursor-models.provider.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

const router = express.Router();

// GET /api/cursor/config - Read Cursor CLI configuration.
router.get('/config', async (req, res) => {
  try {
    const configPath = path.join(os.homedir(), '.cursor', 'cli-config.json');

    try {
      const configContent = await fs.readFile(configPath, 'utf8');
      const config = JSON.parse(configContent);

      res.json({
        success: true,
        config,
        path: configPath,
      });
    } catch (error) {
      // Config doesn't exist or is invalid, so return the UI default shape.
      logger.info('Cursor config not found or invalid:', errorMessage(error));

      res.json({
        success: true,
        config: {
          version: 1,
          model: {
            modelId: CURSOR_FALLBACK_MODELS.DEFAULT,
            displayName: 'GPT-5',
          },
          permissions: {
            allow: [],
            deny: [],
          },
        },
        isDefault: true,
      });
    }
  } catch (error) {
    console.error('Error reading Cursor config:', error);
    res.status(500).json({
      error: 'Failed to read Cursor configuration',
      details: errorMessage(error),
    });
  }
});

export default router;
