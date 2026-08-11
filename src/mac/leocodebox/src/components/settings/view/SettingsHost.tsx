import { lazy, Suspense, useMemo } from 'react';
import ReactDOM from 'react-dom';

import type { Project } from '../../../types/app';
import { normalizeProjectForSettings } from '../../sidebar/utils/utils';

const Settings = lazy(() => import('./Settings'));

type SettingsHostProps = {
  isOpen: boolean;
  initialTab: string;
  projects: Project[];
  onClose: () => void;
};

export default function SettingsHost({ isOpen, initialTab, projects, onClose }: SettingsHostProps) {
  const settingsProjects = useMemo(
    () => projects.map(normalizeProjectForSettings),
    [projects],
  );

  if (!isOpen) return null;

  return ReactDOM.createPortal(
    <Suspense fallback={<div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 text-sm text-muted-foreground">正在打开设置…</div>}>
      <Settings
        isOpen={isOpen}
        onClose={onClose}
        projects={settingsProjects}
        initialTab={initialTab}
      />
    </Suspense>,
    document.body,
  );
}
