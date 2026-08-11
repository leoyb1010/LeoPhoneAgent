import type { ReactNode } from 'react';

import { cn } from '../../../lib/utils';

type SettingsSectionProps = {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
};

export default function SettingsSection({ title, description, children, className }: SettingsSectionProps) {
  return (
    <section className={cn('space-y-3', className)}>
      <div className="max-w-3xl">
        <h3 className="text-[15px] font-semibold tracking-tight text-foreground">
          {title}
        </h3>
        {description && (
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}
