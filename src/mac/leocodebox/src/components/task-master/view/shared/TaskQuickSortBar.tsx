import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';
import type { TaskBoardSortField, TaskBoardSortOrder } from '../../types';

type TaskQuickSortBarProps = {
  sortField: TaskBoardSortField;
  sortOrder: TaskBoardSortOrder;
  onSortChange: (field: TaskBoardSortField) => void;
};

function getSortIcon(field: TaskBoardSortField, currentField: TaskBoardSortField, currentOrder: TaskBoardSortOrder) {
  if (field !== currentField) {
    return <ArrowUpDown className="h-4 w-4" />;
  }

  return currentOrder === 'asc' ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />;
}

export default function TaskQuickSortBar({ sortField, sortOrder, onSortChange }: TaskQuickSortBarProps) {
  const { t } = useTranslation('tasks');

  return (
    <div className="flex flex-wrap gap-2">
      <button
        onClick={() => onSortChange('id')}
        className={cn(
          'flex items-center gap-1 px-3 py-1.5 rounded-md text-sm',
          sortField === 'id'
            ? 'bg-info dark:bg-info/15 text-info dark:text-info'
            : 'bg-muted dark:bg-muted text-muted-foreground dark:text-muted-foreground hover:bg-muted dark:hover:bg-muted',
        )}
      >
        {t('sort.id')} {getSortIcon('id', sortField, sortOrder)}
      </button>

      <button
        onClick={() => onSortChange('status')}
        className={cn(
          'flex items-center gap-1 px-3 py-1.5 rounded-md text-sm',
          sortField === 'status'
            ? 'bg-info dark:bg-info/15 text-info dark:text-info'
            : 'bg-muted dark:bg-muted text-muted-foreground dark:text-muted-foreground hover:bg-muted dark:hover:bg-muted',
        )}
      >
        {t('sort.status')} {getSortIcon('status', sortField, sortOrder)}
      </button>

      <button
        onClick={() => onSortChange('priority')}
        className={cn(
          'flex items-center gap-1 px-3 py-1.5 rounded-md text-sm',
          sortField === 'priority'
            ? 'bg-info dark:bg-info/15 text-info dark:text-info'
            : 'bg-muted dark:bg-muted text-muted-foreground dark:text-muted-foreground hover:bg-muted dark:hover:bg-muted',
        )}
      >
        {t('sort.priority')} {getSortIcon('priority', sortField, sortOrder)}
      </button>
    </div>
  );
}
