import { readUserQuotaCredential } from './ai-quota.credentials.js';
import { accentFor, type ProviderDetailSection, type ProviderSnapshot } from './ai-quota.types.js';

/**
 * [T-quota-credentials] Grok(xAI)的探针。入口是一把 xAI API key ——
 * 优先用用户在设置里手填的那把,没有才回落到 XAI_API_KEY 环境变量。
 *
 * 单独开一个文件而不是塞进 ai-quota.service.ts,是为了让"用户凭据"这条线
 * 集中在自己的文件里 —— service.ts 那边只加一行 import 和一个 probe。
 *
 * 关于"额度"这件事,必须说实话(2026-08 查证 docs.x.ai):
 *  - `GET https://api.x.ai/v1/api-key` 是**有官方文档的**,拿 `xai-` 推理 key
 *    就能调,返回 key 的启用/封禁状态、ACL、team_id。这条我们接了。
 *  - **xAI 没有给推理 key 开任何"剩余额度 / 已用量"接口。** 探测
 *    /v1/credits、/v1/usage、/v1/billing 全是 404(真实端点是 401),
 *    可以确认不是权限问题而是根本不存在。余额只在
 *    `https://management-api.x.ai/v1/billing/teams/{team_id}/prepaid/balance`,
 *    而那需要另一把**管理密钥**(与 xai- key 不是一回事,得在控制台单独生成)。
 *
 * 所以这里**不造任何百分比窗口**:能读到的是"这把 key 好不好使、属于哪个 team",
 * 就如实报这些,再用 note 说明余额为什么读不到。按契约,一个假的"额度还很满"
 * 比一片空白危险得多。
 */

const XAI_API_KEY_URL = 'https://api.x.ai/v1/api-key';

/** 与 ai-quota.service.ts 的 requestJson 同形;由调用方注入,便于测试。 */
export type GrokHttp = (
  url: string,
  headers: Record<string, string>,
) => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const stringOr = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const base = (): ProviderSnapshot => ({
  id: 'grok',
  label: 'Grok',
  accentColor: accentFor('grok'),
  status: 'unconfigured',
  source: 'none',
  updatedAt: null,
});

/** 没填 key 时的说明。照抄原来的 note 再补一句"去哪拿、贴哪里"。 */
export const GROK_UNCONFIGURED_NOTE =
  '本机有 ~/.grok,但额度要查 xAI 控制台;缺一个可用的 xAI API key 或会话凭据。'
  + '在 console.x.ai 生成一个 xai- 开头的 API key,填到「设置 → AI 额度」里即可校验并读出 key 状态。';

/** 余额读不到的原因,固定文案 —— 用户不该以为是我们没实现完。 */
const NO_BALANCE_NOTE =
  'xAI 没有为 xai- 推理 key 提供任何余额或用量接口(官方文档里只有控制台可看),'
  + '所以这里不显示百分比额度。余额需要另一把管理密钥走 management-api.x.ai 的账单接口。';

/**
 * 凭据优先级:**用户手填 > 本机自动发现。**
 *
 * 自动发现这一侧只认 `XAI_API_KEY` —— 那是 xAI 官方 SDK 的标准环境变量。
 * `~/.grok/auth.json` 里那个 `eyJ...` 是 grok CLI 的 OIDC 会话 JWT,不是
 * `xai-` API key,拿去调 /v1/api-key 只会换来一个让人摸不着头脑的 401,
 * 所以**故意不读它**。
 *
 * 用户特意贴了 key,就说明环境里那份不好使 —— 手填的永远压过自动发现的。
 */
export async function readGrokSnapshot(http: GrokHttp, nowMs: number): Promise<ProviderSnapshot> {
  const userKey = await readUserQuotaCredential('grok');
  const envKey = process.env.XAI_API_KEY?.trim() || null;
  const apiKey = userKey ?? envKey;
  const origin = userKey ? '手动填写' : 'XAI_API_KEY 环境变量';
  if (!apiKey) return { ...base(), note: GROK_UNCONFIGURED_NOTE };

  const result = await http(XAI_API_KEY_URL, { Authorization: `Bearer ${apiKey}` });
  if (!result.ok) {
    return { ...base(), status: 'error', error: `校验 xAI API key 失败:${result.message}` };
  }
  if (!isRecord(result.data)) {
    return { ...base(), status: 'error', error: 'xAI 返回了无法识别的结构' };
  }

  const payload = result.data;
  // 封禁/停用的 key 调用会照样返回 200 —— 不当成错误报出来,用户会一直以为好着。
  const blockers: string[] = [];
  if (payload.api_key_blocked === true) blockers.push('这把 key 已被封禁');
  if (payload.api_key_disabled === true) blockers.push('这把 key 已被停用');
  if (payload.team_blocked === true) blockers.push('所属 team 已被封禁');

  const acls = Array.isArray(payload.acls) ? payload.acls.filter((item): item is string => typeof item === 'string') : [];
  const teamId = stringOr(payload.team_id);
  const rows = [
    stringOr(payload.name) ? { label: 'Key 名称', value: stringOr(payload.name) as string } : null,
    // xAI 自己回传的就是打码后的形式(xai-...b14o),不是完整 key。
    stringOr(payload.redacted_api_key) ? { label: 'Key', value: stringOr(payload.redacted_api_key) as string } : null,
    teamId ? { label: 'Team', value: teamId } : null,
    { label: '凭据来源', value: origin },
    acls.length > 0 ? { label: '权限', value: `${acls.length} 项`, secondaryValue: acls.slice(0, 3).join('、') } : null,
  ].filter((row): row is { label: string; value: string; secondaryValue?: string } => row !== null);

  const details: ProviderDetailSection[] = rows.length > 0 ? [{ title: 'API Key', rows }] : [];

  if (blockers.length > 0) {
    return {
      ...base(),
      status: 'error',
      source: 'api',
      details,
      updatedAt: nowMs,
      error: `${blockers.join(';')} —— 去 console.x.ai 换一把可用的 key。`,
    };
  }

  return {
    ...base(),
    status: 'ok',
    source: 'api',
    identity: { organization: teamId, plan: null, accountEmail: null },
    details,
    updatedAt: nowMs,
    note: NO_BALANCE_NOTE,
  };
}
