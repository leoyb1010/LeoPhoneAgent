import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Dialog, DialogContent } from '../../shared/view/ui/Dialog';
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

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        placement="left"
        aria-label={t('workbench.projects', { defaultValue: '项目' })}
        className="bg-card shadow-elevation-3"
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
      </DialogContent>
    </Dialog>
  );
}
