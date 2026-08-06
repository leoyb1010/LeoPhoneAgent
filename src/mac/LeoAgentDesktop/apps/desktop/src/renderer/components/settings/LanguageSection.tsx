/**
 * LanguageSection — Settings 页"显示语言"区块。
 *
 * 5 个 pill 选项 (Auto + 4 种具体语言) 横排，cardstyle 与 NotificationSection 同级
 * (rounded 12 / Card bg / 1px Board / padding 20)。选中态参考 SettingsView 的 tab：
 * 选中 = 卡片选中色 + 1px 边框 + 中粗；未选 = 透明 + hover 浅底。
 *
 * 设计上与 Theme 不同 —— Theme 是三张大预览卡 (有视觉差异)，Language 是 5 个文本 pill
 * (每项之间无视觉预览差，纯文字)，所以选 pill 而非 ThemeCard。
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useLocale } from '@/hooks/useLocale';
import { SUPPORTED_LOCALES, type LocalePreference } from '@/i18n';

const LANGUAGE_OPTIONS: ReadonlyArray<LocalePreference> = ['system', ...SUPPORTED_LOCALES];

export function LanguageSection() {
  const { t } = useTranslation();
  const { locale, setLocale } = useLocale();

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const idx = LANGUAGE_OPTIONS.indexOf(locale);
      let nextIdx = idx;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        nextIdx = (idx + 1) % LANGUAGE_OPTIONS.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        nextIdx = (idx - 1 + LANGUAGE_OPTIONS.length) % LANGUAGE_OPTIONS.length;
      } else {
        return;
      }
      setLocale(LANGUAGE_OPTIONS[nextIdx]);
    },
    [locale, setLocale],
  );

  return (
    <div className="flex flex-col gap-[14px]">
      <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {t('settings.language.title')}
      </h2>

      <div
        className={cn(
          'flex flex-col gap-3 rounded-xl p-5',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex flex-col gap-1">
          <p
            className="text-13 font-medium text-[var(--settings-section-sublabel)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {t('settings.language.label')}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.language.hint')}
          </p>
        </div>

        <div
          className="flex flex-wrap gap-2"
          role="radiogroup"
          aria-label={t('settings.language.ariaLabel')}
        >
          {LANGUAGE_OPTIONS.map((opt) => {
            const selected = locale === opt;
            return (
              <button
                key={opt}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => setLocale(opt)}
                onKeyDown={handleKeyDown}
                className={cn(
                  'rounded-full px-4 py-1.5 text-13 transition-colors',
                  selected
                    ? 'bg-[var(--settings-menu-bg-selected)] font-medium text-[var(--settings-menu-text-selected)] border border-[var(--settings-menu-border-selected)]'
                    : 'border border-transparent text-[var(--settings-menu-text)] hover:bg-[var(--settings-menu-bg-hover)]',
                )}
              >
                {t(`settings.language.options.${opt}`)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
