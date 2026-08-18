import express from 'express';

import { clearAiCostCache, readAiCost } from './ai-cost.service.js';
import { clearAiQuotaCache, readAiQuota } from './ai-quota.service.js';

const router: express.Router = express.Router();

/** 状态栏 AI 额度浮窗的数据面。`?refresh=1` 跳过 60 秒缓存。 */
router.get('/quota', async (req, res) => {
  if (req.query.refresh === '1') {
    clearAiQuotaCache();
    clearAiCostCache();
  }
  try {
    const [providers, costs] = await Promise.all([readAiQuota(), readAiCost()]);
    // 成本按 provider 挂回去,面板一次请求就能画完整张卡。
    const byProvider = new Map(costs.map((cost) => [cost.provider, cost]));
    res.json({
      success: true,
      providers: providers.map((provider) => ({ ...provider, cost: byProvider.get(provider.id) ?? null })),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { message: error instanceof Error ? error.message : 'quota probe failed' },
    });
  }
});

export default router;
