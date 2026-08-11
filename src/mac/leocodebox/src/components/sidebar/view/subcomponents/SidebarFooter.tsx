import { AlertTriangle, ArrowUpCircle, Bug, Settings, SlidersHorizontal } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { ReleaseInfo } from '../../../../types/sharedTypes';

type SidebarFooterProps = {
  updateAvailable: boolean;
  restartRequired: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  currentVersion: string;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  onShowLeoapi: () => void;
  onShowFeedback: () => void;
  t: TFunction;
};

export default function SidebarFooter({
  updateAvailable,
  restartRequired,
  releaseInfo,
  latestVersion,
  currentVersion,
  onShowVersionModal,
  onShowSettings,
  onShowLeoapi,
  onShowFeedback,
  t,
}: SidebarFooterProps) {
  return (
    <div className="flex-shrink-0 border-t border-border/60 p-2" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0px))' }}>
      {restartRequired && (
        <div className="mb-1.5 flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs text-warning dark:text-warning">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{t('version.restartRequired')}</span>
        </div>
      )}
      {updateAvailable && (
        <button
          className="mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-primary hover:bg-primary/10"
          onClick={onShowVersionModal}
        >
          <ArrowUpCircle className="h-3.5 w-3.5" />
          <span className="truncate">{releaseInfo?.title || t('localUi.updateTo', { version: latestVersion })}</span>
        </button>
      )}
      <div className="grid grid-cols-3 gap-1 md:hidden">
        <button
          type="button"
          onClick={onShowFeedback}
          className="flex items-center justify-center gap-1.5 rounded-md px-1.5 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Bug className="h-3.5 w-3.5" />{t('localUi.localLog')}
        </button>
        <button
          type="button"
          onClick={onShowLeoapi}
          className="flex items-center justify-center gap-1.5 rounded-md px-1.5 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />Leoapi
        </button>
        <button
          className="flex items-center justify-center gap-1.5 rounded-md px-1.5 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onShowSettings}
        >
          <Settings className="h-3.5 w-3.5" />{t('localUi.settings')}
        </button>
      </div>
      <div className="flex items-center justify-between px-2.5 pt-1 text-[10px] text-muted-foreground/50">
        <span>leocodebox v{currentVersion}</span>
        <span className="hidden items-center gap-1 md:inline-flex"><span className="h-1.5 w-1.5 rounded-full bg-success" />{t('localUi.localMode')}</span>
      </div>
    </div>
  );
}
