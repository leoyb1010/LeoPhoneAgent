import { useCallback, useEffect, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { apiClient } from '../../../../utils/apiClient';
import { Button } from '../../../../shared/view/ui';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';

type RecycledEntry = {
  id: string;
  originalPath: string;
  recycledAt: string;
  meta?: { reason?: string; provider?: string; directoryName?: string };
};
type ConfigBackup = { name: string; size: number; modifiedAt: string };

const basename = (value: string): string => value.replace(/\\/g, '/').split('/').filter(Boolean).pop() || value;
const formatTime = (iso: string): string => {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toLocaleString();
};
const formatSize = (bytes: number): string => (
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`
);

/** Recover soft-deleted skills and inspect config backups. Read + restore only. */
export default function RecoverySection() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<RecycledEntry[]>([]);
  const [backups, setBackups] = useState<ConfigBackup[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [recycle, backup] = await Promise.all([
        apiClient.get<{ success: boolean; entries?: RecycledEntry[] }>('/api/leocodebox/recycle'),
        apiClient.get<{ success: boolean; backups?: ConfigBackup[] }>('/api/leocodebox/config-backups'),
      ]);
      setEntries(recycle?.entries ?? []);
      setBackups(backup?.backups ?? []);
    } catch {
      // Keep last known state.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleRestore = useCallback(async (id: string) => {
    setBusy(id);
    setMessage(null);
    try {
      const res = await apiClient.post<{ success: boolean; restored?: boolean }>(`/api/leocodebox/recycle/${id}/restore`);
      setMessage(res?.restored
        ? t('recovery.restored', { defaultValue: '已还原到原位置。' })
        : t('recovery.conflict', { defaultValue: '原位置已存在同名内容,未覆盖。' }));
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Restore failed');
    } finally {
      setBusy(null);
    }
  }, [load, t]);

  return (
    <div className="space-y-6">
      <SettingsSection
        title={t('recovery.recycleTitle', { defaultValue: '回收站' })}
        description={t('recovery.recycleDesc', { defaultValue: '被删除或覆盖的技能会在这里保留 30 天,可一键还原。' })}
      >
        {message && (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">{message}</div>
        )}
        {entries.length === 0 ? (
          <SettingsCard>
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t('recovery.recycleEmpty', { defaultValue: '回收站是空的——很好。' })}
            </div>
          </SettingsCard>
        ) : (
          <SettingsCard divided>
            {entries.map((entry) => (
              <SettingsRow
                key={entry.id}
                label={basename(entry.originalPath)}
                description={`${formatTime(entry.recycledAt)}${entry.meta?.provider ? ` · ${entry.meta.provider}` : ''}`}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void handleRestore(entry.id)}
                >
                  {busy === entry.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                  {t('recovery.restore', { defaultValue: '还原' })}
                </Button>
              </SettingsRow>
            ))}
          </SettingsCard>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('recovery.backupsTitle', { defaultValue: '配置备份' })}
        description={t('recovery.backupsDesc', { defaultValue: '覆盖 CLI 配置(如 ~/.claude.json)前自动保留的上一版,存于 ~/.leocodebox/config-backups。' })}
      >
        {backups.length === 0 ? (
          <SettingsCard>
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t('recovery.backupsEmpty', { defaultValue: '暂无配置备份。' })}
            </div>
          </SettingsCard>
        ) : (
          <SettingsCard divided>
            {backups.map((backup) => (
              <SettingsRow key={backup.name} label={backup.name} description={`${formatTime(backup.modifiedAt)} · ${formatSize(backup.size)}`}>
                <span className="text-xs text-muted-foreground">{t('recovery.readOnly', { defaultValue: '只读' })}</span>
              </SettingsRow>
            ))}
          </SettingsCard>
        )}
      </SettingsSection>
    </div>
  );
}
