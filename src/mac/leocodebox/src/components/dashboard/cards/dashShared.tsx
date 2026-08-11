import * as React from 'react';
import { AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';
import { Card } from '../../../shared/view/ui';

/** Coloured status dot with a smooth colour transition. */
export function StatusDot({ tone, pulse = false, className }: { tone: 'ok' | 'warn' | 'fail' | 'idle'; pulse?: boolean; className?: string }) {
  const color = tone === 'ok'
    ? 'bg-success'
    : tone === 'warn'
      ? 'bg-warning'
      : tone === 'fail'
        ? 'bg-destructive'
        : 'bg-muted-foreground/40';
  return (
    <span
      className={cn('dash-status-dot inline-block h-2 w-2 flex-shrink-0 rounded-full', color, pulse && 'animate-pulse', className)}
    />
  );
}

/** Card wrapper that staggers its entrance via --dash-delay. */
export function DashCard({
  delay = 0,
  interactive = false,
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { delay?: number; interactive?: boolean }) {
  return (
    <Card
      className={cn('dash-enter', interactive && 'dash-card-interactive', className)}
      style={{ ['--dash-delay' as string]: `${delay}ms` }}
      {...rest}
    >
      {children}
    </Card>
  );
}

/** Section heading row used inside dashboard cards. */
export function DashCardTitle({ title, action }: { title: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h3 className="text-[14px] font-medium text-foreground">{title}</h3>
      {action}
    </div>
  );
}

/** Inline error strip with a retry button — never a full-page blank. */
export function DashError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
      <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="min-w-0 flex-1 truncate">{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="flex-shrink-0 font-medium underline-offset-2 hover:underline">
          {t('errorBoundary.retry', { defaultValue: '重试' })}
        </button>
      )}
    </div>
  );
}

/** Friendly empty state with an optional call-to-action. */
export function DashEmpty({ message, actionLabel, onAction }: { message: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
      <p className="text-[13px] text-muted-foreground">{message}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition-transform hover:scale-[1.02]"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/** Skeleton block matching the final layout so nothing jumps on load. */
export function DashSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="h-12 animate-pulse rounded-md bg-secondary/70"
          style={{ opacity: 1 - index * 0.15 }}
        />
      ))}
    </div>
  );
}
