import { useMemo } from 'react';
import type { ScheduleTemplate } from '@cindy/maker-scheduler';

import { TemplateCard } from './TemplateCard';
import { useTemplates } from '../hooks/useTemplates';

interface TemplateGalleryProps {
  onSelect: (template: ScheduleTemplate) => void;
  selectedId?: string;
}

export function TemplateGallery({ onSelect, selectedId }: TemplateGalleryProps) {
  const { templates, categories, loading } = useTemplates();
  const orderedCategories = useMemo(
    () => [...categories].sort((a, b) => a.order - b.order),
    [categories],
  );

  if (loading || templates.length === 0) return null;

  return (
    <div className="flex flex-col gap-6">
      {orderedCategories.map((category) => {
        const items = templates.filter((template) => template.category === category.id);
        if (items.length === 0) return null;
        return (
          <section key={category.id} className="flex flex-col gap-2">
            <h3 className="text-10 font-medium leading-none tracking-[0.6px] text-[var(--cmd-palette-item-meta)]">
              {category.name}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {items.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  selected={template.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
