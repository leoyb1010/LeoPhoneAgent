import { Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';
import { PillBar, Pill } from '../../../shared/view/ui';
import {
  SETTINGS_MAIN_TABS,
  SETTINGS_TAB_GROUP_KEYS,
  type SettingsMainTabGroup,
  type SettingsMainTabMeta,
} from '../constants/constants';
import type { SettingsMainTab } from '../types/types';

type SettingsSidebarProps = {
  activeTab: SettingsMainTab;
  onChange: (tab: SettingsMainTab) => void;
};

const GROUP_ORDER: SettingsMainTabGroup[] = ['agent', 'workspace', 'system'];

/**
 * [T-settings-ia] 分组 + 搜索的设置导航。
 *
 * 与 LeoPhoneAgent 的设置首页同构:平铺 13 项改成三组,顶部一个搜索框
 * 按标题 + 关键词(中英混合)过滤,搜索时扁平列出命中项。数据来自
 * SETTINGS_MAIN_TABS 这一个真源,增删 tab 只改那一处。
 */
export default function SettingsSidebar({ activeTab, onChange }: SettingsSidebarProps) {
  const { t } = useTranslation('settings');
  const [query, setQuery] = useState('');

  const searching = query.trim().length > 0;

  const hits = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return SETTINGS_MAIN_TABS;
    return SETTINGS_MAIN_TABS.filter((item) => {
      const haystack = `${item.label} ${item.keywords} ${t(item.labelKey)}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [query, t]);

  const renderButton = (item: SettingsMainTabMeta) => {
    const Icon = item.icon;
    const isActive = activeTab === item.id;
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => onChange(item.id)}
        aria-current={isActive ? 'page' : undefined}
        className={cn(
          'leo-squish group flex min-h-10 w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm font-medium transition-colors',
          isActive
            ? 'bg-primary/[0.09] text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.14)]'
            : 'text-muted-foreground hover:bg-accent/55 hover:text-foreground active:bg-accent/70',
        )}
      >
        <span className={cn(
          'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg transition-colors',
          isActive ? 'bg-primary/10' : 'bg-background/70 group-hover:bg-background',
        )}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="truncate">{t(item.labelKey)}</span>
      </button>
    );
  };

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="leocodebox-settings-nav hidden w-56 flex-shrink-0 flex-col border-r border-border/80 md:flex">
        <div className="px-3 pb-1 pt-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('search.placeholder', { defaultValue: '搜索设置' })}
              className="h-9 w-full rounded-xl border border-border/80 bg-background/75 pl-9 pr-8 text-sm outline-none transition-shadow focus:border-primary/45 focus:shadow-[0_0_0_3px_hsl(var(--primary)/0.08)]"
            />
            {searching && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('search.clear', { defaultValue: '清除' })}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <nav className="flex flex-col gap-0.5 overflow-y-auto p-3 pt-2">
          {searching ? (
            hits.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {t('search.noResults', { defaultValue: '没有匹配的设置项' })}
              </p>
            ) : (
              hits.map(renderButton)
            )
          ) : (
            GROUP_ORDER.map((group) => {
              const items = SETTINGS_MAIN_TABS.filter((item) => item.group === group);
              if (items.length === 0) return null;
              return (
                <div key={group} className="mb-2">
                  <p className="px-2.5 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
                    {t(SETTINGS_TAB_GROUP_KEYS[group])}
                  </p>
                  {items.map(renderButton)}
                </div>
              );
            })
          )}
        </nav>
      </aside>

      {/* Mobile horizontal nav — pill bar(窄屏没有分组空间,保持一行滑动) */}
      <div className="flex-shrink-0 border-b border-border px-3 py-2 md:hidden">
        <PillBar className="scrollbar-hide w-full overflow-x-auto">
          {SETTINGS_MAIN_TABS.map((item) => {
            const Icon = item.icon;
            return (
              <Pill
                key={item.id}
                isActive={activeTab === item.id}
                onClick={() => onChange(item.id)}
                className="flex-shrink-0"
              >
                <Icon className="h-3.5 w-3.5" />
                {t(item.labelKey)}
              </Pill>
            );
          })}
        </PillBar>
      </div>
    </>
  );
}
