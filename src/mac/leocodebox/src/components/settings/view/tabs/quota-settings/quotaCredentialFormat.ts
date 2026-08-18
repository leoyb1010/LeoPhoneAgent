/**
 * [T-quota-credentials] 「设置 → AI 额度」的纯展示层。
 *
 * 抽出来是为了能脱离 React 被单测钉住:这一页唯一的内容就是**状态判断和文案**,
 * 判错一次就会让用户以为自己接上了(或者以为没接上),比画歪一个圆点严重得多。
 *
 * 一条硬规则:服务端只回传脱敏视图(configured + last4 + updatedAt),
 * 这里也**不存在**任何能拿到完整 key 的路径。输入框里的值只在提交那一刻存在。
 */

import type { ProviderSnapshot, Translate } from '../../../../workbench/quotaFormat';

/** 需要用户手填凭据的 provider,与服务端 QUOTA_CREDENTIAL_PROVIDERS 一致。 */
export const CREDENTIAL_PROVIDERS = ['gemini', 'cursor', 'grok', 'opencode'] as const;
export type CredentialProviderId = (typeof CREDENTIAL_PROVIDERS)[number];

/** 服务端脱敏视图。**没有 apiKey 字段是故意的**,别加。 */
export type QuotaCredentialStatus = {
  provider: CredentialProviderId;
  configured: boolean;
  last4: string | null;
  updatedAt: string | null;
};

/**
 * 状态点的四档。分档看的是**数字的来路**,不只是"有没有报错":
 *  - `ok`   服务端下发的权威额度,可以当额度用
 *  - `local` 本机日志累加的估算,不是官方配额 —— 必须和 ok 区分开
 *  - `error` 取数失败
 *  - `idle`  还没接入
 */
export type ProviderTone = 'ok' | 'local' | 'error' | 'idle';

export function providerTone(snapshot: Pick<ProviderSnapshot, 'status' | 'source'>): ProviderTone {
  if (snapshot.status === 'error') return 'error';
  if (snapshot.status === 'unconfigured') return 'idle';
  if (snapshot.status === 'ok') return snapshot.source === 'local' ? 'local' : 'ok';
  return 'idle';
}

export const TONE_DOT_CLASS: Record<ProviderTone, string> = {
  ok: 'bg-emerald-500',
  local: 'bg-amber-500',
  error: 'bg-destructive',
  idle: 'bg-muted-foreground/40',
};

/** 一行右侧那句话:接没接上 + 数字打哪来。两者缺一句用户都会误读。 */
export function statusLabel(snapshot: Pick<ProviderSnapshot, 'status' | 'source'>, t: Translate): string {
  const tone = providerTone(snapshot);
  if (tone === 'error') return t('quota.status.error');
  if (tone === 'idle') return t('quota.status.notConnected');
  return `${t('quota.status.connected')} · ${t(`quota.source.${snapshot.source}`)}`;
}

/** 已配置的凭据只说"配了 + 尾号";短 key 没有尾号,就只说配了。 */
export function credentialLabel(status: QuotaCredentialStatus | undefined, t: Translate): string {
  if (!status?.configured) return t('quota.credential.notConfigured');
  return status.last4
    ? t('quota.credential.configuredWithTail', { last4: status.last4 })
    : t('quota.credential.configured');
}

/**
 * ISO 串 → 本地可读时间。解析不了就返回 null,**不要**回落到 "1970"
 * 或者当前时间 —— 一个假的"刚刚更新"比空白危险得多。
 */
export function formatTimestamp(value: string | number | null | undefined, locale?: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * 已自动接入的那几家,凭据是从哪读到的。
 * Claude 的具体来源(钥匙串 / 凭据文件)由服务端在 details 里给,
 * 拿得到就用服务端那份 —— 它才知道这台机器上实际命中的是哪个源。
 */
export function autoCredentialOrigin(snapshot: Pick<ProviderSnapshot, 'details'> | undefined): string | null {
  for (const section of snapshot?.details ?? []) {
    for (const row of section.rows) {
      if (row.label === '凭据来源') return row.value;
    }
  }
  return null;
}

/** 排序:先已接入的自动几家,再需要手填的,清单读起来才有次序。 */
export const PROVIDER_ORDER = ['codex', 'claude', 'gemini', 'cursor', 'grok', 'opencode'];

export function sortProviders<T extends { id: string }>(providers: T[]): T[] {
  return [...providers].sort((a, b) => {
    const ai = PROVIDER_ORDER.indexOf(a.id);
    const bi = PROVIDER_ORDER.indexOf(b.id);
    // 清单里没登记的排最后,但**照样显示** —— 缺的那家不能凭空消失。
    return (ai === -1 ? PROVIDER_ORDER.length : ai) - (bi === -1 ? PROVIDER_ORDER.length : bi);
  });
}

export const isCredentialProvider = (id: string): id is CredentialProviderId =>
  (CREDENTIAL_PROVIDERS as readonly string[]).includes(id);
