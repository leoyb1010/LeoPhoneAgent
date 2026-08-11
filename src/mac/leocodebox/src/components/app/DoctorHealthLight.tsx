import { useEffect, useRef, useState } from 'react';
import { Stethoscope } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useDoctorReport } from '../../hooks/useDoctorReport';

import { resolveDoctorTone, type DoctorTone } from './doctorLight';

const TONE_DOT: Record<DoctorTone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  fail: 'bg-destructive',
};

/** Status-bar environment health light with an upward check-list popover. */
export default function DoctorHealthLight() {
  const { t } = useTranslation();
  const report = useDoctorReport();
  const tone = resolveDoctorTone(report?.summary);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // ⌘K "环境体检" opens the same popover.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('leocodebox:open-doctor', onOpen);
    return () => window.removeEventListener('leocodebox:open-doctor', onOpen);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const summary = report?.summary;
  const label = !summary
    ? t('workspaceShell.healthChecking', { defaultValue: '体检中' })
    : summary.fail > 0
      ? t('workspaceShell.healthFail', { count: summary.fail, defaultValue: '{{count}} 项异常' })
      : summary.warn > 0
        ? t('workspaceShell.healthWarn', { count: summary.warn, defaultValue: '{{count}} 项注意' })
        : t('workspaceShell.healthOk', { defaultValue: '环境就绪' });

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
        title={label}
        aria-label={label}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[tone]} ${tone !== 'ok' ? 'animate-pulse' : ''}`} />
        <Stethoscope className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-[70] mb-2 max-h-[60vh] w-72 overflow-y-auto rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-elevation-2">
          <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('workspaceShell.healthTitle', { defaultValue: '环境体检' })}
          </div>
          {(report?.checks ?? []).length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {t('workspaceShell.healthChecking', { defaultValue: '体检中…' })}
            </div>
          ) : (
            <ul className="space-y-0.5">
              {report!.checks.map((check) => (
                <li key={check.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent/50">
                  <span className={`mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full ${TONE_DOT[check.status]}`} />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-foreground">{check.label}</span>
                    <span className="block truncate text-muted-foreground">{check.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
