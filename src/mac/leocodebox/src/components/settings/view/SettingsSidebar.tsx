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
        onClick={() => onChange(item.id)}
        className={cn(
          'flex items-center gap-3 rounded-md border-l-2 px-3 py-2 text-left text-sm font-medium',
          isActive
            ? 'border-l-primary bg-primary/[0.07] text-foreground'
            : 'border-l-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground active:bg-accent/50',
        )}
      >
        <Icon className="h-4 w-4 flex-shrink-0" />
        {t(item.labelKey)}
      </button>
    );
  };

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="leocodebox-settings-nav hidden w-52 flex-shrink-0 flex-col border-r border-border md:flex">
        <div className="px-3 pb-1 pt-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('search.placeholder', { defaultValue: '搜索设置' })}
              className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-7 text-sm outline-none focus:border-primary"
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
                <div key={group} className="mb-1">
                  <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
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
