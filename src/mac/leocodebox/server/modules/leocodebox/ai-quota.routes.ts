import express from 'express';

import { clearAiQuotaCache, readAiQuota } from './ai-quota.service.js';

const router: express.Router = express.Router();

/** 状态栏 AI 额度浮窗的数据面。`?refresh=1` 跳过 60 秒缓存。 */
router.get('/quota', async (req, res) => {
  if (req.query.refresh === '1') clearAiQuotaCache();
  try {
    res.json({ success: true, providers: await readAiQuota() });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { message: error instanceof Error ? error.message : 'quota probe failed' },
    });
  }
});

export default router;
