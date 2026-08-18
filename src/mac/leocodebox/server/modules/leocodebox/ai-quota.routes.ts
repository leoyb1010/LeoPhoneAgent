import express from 'express';

import { clearAiCostCache, readAiCost } from './ai-cost.service.js';
import { clearAiQuotaCache, readAiQuota } from './ai-quota.service.js';
import type { ProviderCost } from './ai-quota.types.js';

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
    // ai-cost 的字段名和额度契约里的 ProviderCost 不一样,在这里翻译一次,
    // 免得每个前端各译一遍。
    const byProvider = new Map(costs.map((cost) => [cost.provider, cost]));
    res.json({
      success: true,
      providers: providers.map((provider) => {
        const cost = byProvider.get(provider.id);
        const mapped: ProviderCost | null = cost
          ? {
            todayUSD: cost.todayCostUSD,
            last30DaysUSD: cost.last30DaysCostUSD,
            todayTokens: cost.todayTokens,
            last30DaysTokens: cost.last30DaysTokens,
            currencyCode: 'USD',
          }
          : null;
        return { ...provider, cost: mapped };
      }),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { message: error instanceof Error ? error.message : 'quota probe failed' },
    });
  }
});

export default router;
