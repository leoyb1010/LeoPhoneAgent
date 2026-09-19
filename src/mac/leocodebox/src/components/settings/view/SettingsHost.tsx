import { lazy, Suspense, useMemo } from 'react';
import ReactDOM from 'react-dom';

import type { Project } from '../../../types/app';

/** 旧侧栏的项目归一化:设置页只要 displayName / fullPath 两个字段可靠即可。 */
function normalizeProjectForSettings<T extends { projectId: string; displayName?: string; fullPath?: string; path?: string }>(project: T): T & { name: string; displayName: string; fullPath: string } {
  const displayName = project.displayName || project.projectId;
  return { ...project, name: displayName, displayName, fullPath: project.fullPath || project.path || '' };
}

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
