import { useTranslation } from 'react-i18next';

import { DiffPanelShell } from '@/components/diff-panel/DiffPanelShell';
import { resetHelpThread, useHelpThread } from '@/lib/helpThreadStore';
import { HelpThreadView } from './HelpThreadView';

interface HelpAssistantPanelProps {
  open: boolean;
  onClose: () => void;
}

export function HelpAssistantPanel({ open, onClose }: HelpAssistantPanelProps) {
  const { t } = useTranslation();
  const { messages } = useHelpThread();

  return (
    <DiffPanelShell
      open={open}
      onClose={onClose}
      ariaLabel={t('settings.help.panelAriaLabel')}
      title={t('settings.help.panelTitle')}
      defaultWidth={520}
      storageKey="diff-panel-shell:help-assistant-width"
      headerActions={
        messages.length > 0 ? (
          <button
            type="button"
            onClick={resetHelpThread}
            className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-popover-foreground/80 transition-colors hover:bg-titlebar-button-hover"
          >
            {t('settings.help.newSession')}
          </button>
        ) : undefined
      }
    >
      <HelpThreadView />
    </DiffPanelShell>
  );
}
