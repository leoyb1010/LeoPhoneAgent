import type { ReactNode } from 'react';

import { cn } from '../../../lib/utils';

type SettingsCardProps = {
  children: ReactNode;
  className?: string;
  divided?: boolean;
};

export default function SettingsCard({ children, className, divided }: SettingsCardProps) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-border/80 bg-card/70 shadow-elevation-1',
        divided && 'divide-y divide-border',
        className,
      )}
    >
      {children}
    </div>
  );
}
