import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import CollectionsMirror from '../../../fleet/view/CollectionsMirror';

export default function CollectionsWorkspace({ onNewTask }: { onNewTask: () => void }) {
  const { t } = useTranslation();
  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="collections-workspace-title">
      <header className="flex flex-none items-center gap-3 border-b border-border px-5 py-3">
        <button type="button" onClick={onNewTask} className="wb-chip-button h-8 w-8" aria-label={t('commandPalette.goConsole')}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </button>
        <h1 id="collections-workspace-title" className="text-base font-semibold text-foreground">{t('taskStart.libraryTitle')}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6"><CollectionsMirror /></div>
    </section>
  );
}
