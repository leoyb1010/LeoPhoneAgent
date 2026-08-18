import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../../lib/utils';
import { Button, Input } from '../../../../../shared/view/ui';
import { apiClient } from '../../../../../utils/apiClient';
import type { ProviderSnapshot } from '../../../../workbench/quotaFormat';
import SettingsCard from '../../SettingsCard';
import SettingsSection from '../../SettingsSection';

import {
  autoCredentialOrigin,
  credentialLabel,
  formatTimestamp,
  isCredentialProvider,
  providerTone,
  sortProviders,
  statusLabel,
  TONE_DOT_CLASS,
  type CredentialProviderId,
  type QuotaCredentialStatus,
} from './quotaCredentialFormat';

/**
 * [T-quota-credentials] 「设置 → AI 额度」。
 *
 * 这一页要回答的就一个问题:**每家 AI 的额度现在有没有、没有的话差什么、
 * 差的那个东西在哪填。** 所以一行一家:状态点 + 名字 + 接没接上/数字打哪来,
 * 底下一句说明,需要凭据的再多一个输入框。没有仪表盘,没有图形。
 *
 * 安全上的一条:输入框里的 key 提交完就从 state 里抹掉,页面上永远只显示
 * 服务端回传的脱敏结果(已配置 + 尾 4 位)。完整 key 不进任何前端状态。
 */

type QuotaResponse = { success: boolean; providers?: ProviderSnapshot[] };
type CredentialsResponse = { success: boolean; credentials?: QuotaCredentialStatus[] };

export default function QuotaSettingsTab() {
  const { t, i18n } = useTranslation('settings');
  const [providers, setProviders] = useState<ProviderSnapshot[]>([]);
  const [credentials, setCredentials] = useState<QuotaCredentialStatus[]>([]);
  const [drafts, setDrafts] = useState<Partial<Record<CredentialProviderId, string>>>({});
  const [savingProvider, setSavingProvider] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCredentials = useCallback(async () => {
    const data = await apiClient.get<CredentialsResponse>('/api/leocodebox/quota/credentials');
    setCredentials(data.credentials ?? []);
  }, []);

  const loadQuota = useCallback(async (refresh: boolean) => {
    const data = await apiClient.get<QuotaResponse>(`/api/leocodebox/quota${refresh ? '?refresh=1' : ''}`);
    setProviders(sortProviders(data.providers ?? []));
  }, []);

  const loadAll = useCallback(async (refresh: boolean) => {
    setError(null);
    try {
      await Promise.all([loadQuota(refresh), loadCredentials()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('quota.loadError'));
    }
  }, [loadCredentials, loadQuota, t]);

  useEffect(() => {
    void loadAll(false).finally(() => setLoading(false));
  }, [loadAll]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadAll(true);
    setRefreshing(false);
  };

  /** apiKey 传空串 = 清除。写完重新拉一次额度,用户立刻看到有没有生效。 */
  const submitKey = async (provider: CredentialProviderId, apiKey: string) => {
    setSavingProvider(provider);
    setError(null);
    try {
      const data = await apiClient.put<CredentialsResponse>(
        `/api/leocodebox/quota/credentials/${provider}`,
        { apiKey },
      );
      setCredentials(data.credentials ?? []);
      // 明文只活到这一行为止。
      setDrafts((prev) => ({ ...prev, [provider]: '' }));
      await loadQuota(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('quota.saveError'));
    } finally {
      setSavingProvider(null);
    }
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground">{t('quota.loading')}</div>;
  }

  const credentialFor = (id: string) => credentials.find((entry) => entry.provider === id);

  return (
    <div className="space-y-8">
      <SettingsSection title={t('quota.title')} description={t('quota.description')}>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? t('quota.refreshing') : t('quota.refresh')}
          </Button>
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">{error}</p>
        )}

        <SettingsCard divided>
          {providers.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground">{t('quota.empty')}</p>
          )}

          {providers.map((provider) => {
            const tone = providerTone(provider);
            const credential = isCredentialProvider(provider.id) ? credentialFor(provider.id) : undefined;
            const origin = autoCredentialOrigin(provider);
            const updated = formatTimestamp(provider.updatedAt, i18n.language);
            const howToKey = `quota.howTo.${provider.id}`;
            const howTo = t(howToKey, { defaultValue: '' });

            return (
              <div key={provider.id} className="space-y-2 px-4 py-4">
                {/* 一行一个对象:状态点 + 名字 + 接没接上。 */}
                <div className="flex items-baseline justify-between gap-4">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span
                      aria-hidden="true"
                      className={cn('h-1.5 w-1.5 flex-shrink-0 translate-y-[-2px] rounded-full', TONE_DOT_CLASS[tone])}
                    />
                    <span className="truncate text-sm font-medium text-foreground">{provider.label}</span>
                  </div>
                  <span className="flex-shrink-0 text-xs text-muted-foreground">
                    {statusLabel(provider, t)}
                  </span>
                </div>

                {/* 服务端给的这台机器上的实情:缺什么、为什么读不到。 */}
                {(provider.note || provider.error) && (
                  <p className="text-xs leading-5 text-muted-foreground">
                    {provider.error || provider.note}
                  </p>
                )}

                {/* 自动接入的几家:不需要用户动手,但要说清凭据打哪来、什么时候更新的。 */}
                {!credential && tone !== 'idle' && (
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t('quota.autoConnected')}
                    {origin ? ` · ${t('quota.credentialOrigin')}${origin}` : ''}
                    {updated ? ` · ${t('quota.updatedAt', { time: updated })}` : ''}
                  </p>
                )}

                {/* 需要手填的几家:说清去哪拿、贴哪里。 */}
                {credential && (
                  <div className="space-y-2">
                    {howTo && <p className="text-xs leading-5 text-muted-foreground">{howTo}</p>}
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={drafts[credential.provider] ?? ''}
                        onChange={(event) => setDrafts((prev) => ({ ...prev, [credential.provider]: event.target.value }))}
                        placeholder={t('quota.credential.placeholder')}
                        aria-label={t('quota.credential.inputLabel', { provider: provider.label })}
                        className="h-9 min-w-0 flex-1 basis-56 font-mono text-xs"
                      />
                      <Button
                        size="sm"
                        disabled={savingProvider === credential.provider || !(drafts[credential.provider] ?? '').trim()}
                        onClick={() => submitKey(credential.provider, drafts[credential.provider] ?? '')}
                      >
                        {savingProvider === credential.provider ? t('quota.credential.saving') : t('quota.credential.save')}
                      </Button>
                      {credential.configured && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={savingProvider === credential.provider}
                          onClick={() => submitKey(credential.provider, '')}
                          className="text-muted-foreground"
                        >
                          {t('quota.credential.remove')}
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {credentialLabel(credential, t)}
                      {credential.configured && formatTimestamp(credential.updatedAt, i18n.language)
                        ? ` · ${t('quota.updatedAt', { time: formatTimestamp(credential.updatedAt, i18n.language) })}`
                        : ''}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </SettingsCard>

        <p className="text-xs leading-5 text-muted-foreground">{t('quota.storageNote')}</p>
      </SettingsSection>
    </div>
  );
}
