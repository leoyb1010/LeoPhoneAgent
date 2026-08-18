import express from 'express';

import { requireLocalOnly } from '../../shared/local-only.js';

import { clearAiCostCache, readAiCost } from './ai-cost.service.js';
import {
  isQuotaCredentialProvider,
  maskedQuotaCredentials,
  writeQuotaCredential,
} from './ai-quota.credentials.js';
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
            // 不带上就会出现「6 亿 token 花费 $0.00」这种看着像免费的鬼数字。
            unpricedModels: cost.unpricedModels,
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

/* --------------------------------------------------- 用户手填的额度凭据 */

/**
 * [T-quota-credentials] 凭据的读写面。
 *
 * **返回值永远是脱敏视图**(是否已配置 + 尾 4 位 + 更新时间)。
 * 完整 key 只在服务端的 ai-quota.credentials.ts 与请求头里流转,
 * 一次都不回传给前端 —— 前端没有任何理由需要看到它,
 * 而一旦回传,它就会躺在浏览器内存、React DevTools 和任何一次截图里。
 */
router.get('/quota/credentials', async (_req, res, next) => {
  try {
    res.json({ success: true, credentials: await maskedQuotaCredentials() });
  } catch (error) {
    next(error);
  }
});

/** 写入/清除某一家。空串 = 清除。写完清缓存,面板下一次拉取就能看到效果。 */
router.put('/quota/credentials/:provider', requireLocalOnly, async (req, res, next) => {
  const { provider } = req.params;
  if (!isQuotaCredentialProvider(provider)) {
    res.status(400).json({ success: false, error: { message: `未知的 provider:${provider}` } });
    return;
  }
  const apiKey = (req.body as { apiKey?: unknown } | undefined)?.apiKey;
  if (apiKey !== undefined && apiKey !== null && typeof apiKey !== 'string') {
    res.status(400).json({ success: false, error: { message: 'apiKey 必须是字符串' } });
    return;
  }
  // 上限挡住误粘贴整个文件:再长的 key 也到不了 4KB。
  if (typeof apiKey === 'string' && apiKey.length > 4096) {
    res.status(400).json({ success: false, error: { message: 'apiKey 过长' } });
    return;
  }
  try {
    await writeQuotaCredential(provider, typeof apiKey === 'string' ? apiKey : null);
    clearAiQuotaCache();
    res.json({ success: true, credentials: await maskedQuotaCredentials() });
  } catch (error) {
    next(error);
  }
});

router.delete('/quota/credentials/:provider', requireLocalOnly, async (req, res, next) => {
  const { provider } = req.params;
  if (!isQuotaCredentialProvider(provider)) {
    res.status(400).json({ success: false, error: { message: `未知的 provider:${provider}` } });
    return;
  }
  try {
    await writeQuotaCredential(provider, null);
    clearAiQuotaCache();
    res.json({ success: true, credentials: await maskedQuotaCredentials() });
  } catch (error) {
    next(error);
  }
});

export default router;
