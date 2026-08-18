import { useEffect } from 'react';
import ReactDOM from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import Sidebar from '../sidebar/view/Sidebar';

type SidebarProps = Parameters<typeof Sidebar>[0];

type ProjectDrawerProps = {
  open: boolean;
  onClose: () => void;
  /** useProjectsState 组好的 sidebarSharedProps,原样透传。 */
  sidebarProps: SidebarProps;
};

/**
 * 项目抽屉 —— 常驻项目树被删掉之后,它的落脚点。
 *
 * 工作台按会话组织,项目树一天用不到几次(新建项目、改名、归档、按项目搜),
 * 所以它从常驻侧栏变成一个 ⌘K / 会话列表底部按钮唤起的抽屉。里面仍然是
 * 同一个 Sidebar 组件 —— 新建/重命名/删除/归档/搜索一个都没少。
 */
export default function ProjectDrawer({ open, onClose, sidebarProps }: ProjectDrawerProps) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  // 同 LeoapiPanel:portal 到 body,避免被外壳的层级兜底规则拉回文档流。
  return ReactDOM.createPortal(
    <>
      <button
        type="button"
        aria-label={t('workbench.closeProjects', { defaultValue: '关闭项目' })}
        onClick={onClose}
        className="wb-anim-fade fixed inset-0 z-[54] cursor-default bg-black/35 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('workbench.projects', { defaultValue: '项目' })}
        className="wb-anim-inspector fixed bottom-0 left-0 top-0 z-[55] flex w-[320px] max-w-[92vw] flex-col border-r border-border bg-card shadow-elevation-3"
      >
        <div className="flex h-[46px] flex-none items-center border-b border-border px-4">
          <span className="text-[13px] font-bold text-foreground">{t('workbench.projects', { defaultValue: '项目' })}</span>
          <button type="button" onClick={onClose} aria-label={t('workbench.closeProjects', { defaultValue: '关闭项目' })} className="wb-chip-button ml-auto h-[26px] w-[26px]">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <Sidebar {...sidebarProps} />
        </div>
      </div>
    </>,
    document.body,
  );
}
