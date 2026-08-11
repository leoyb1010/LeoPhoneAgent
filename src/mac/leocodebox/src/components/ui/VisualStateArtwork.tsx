import { cn } from '../../lib/utils';

type VisualStateArtworkProps = {
  name: string;
  category?: 'empty-states' | 'errors' | 'onboarding' | 'brand';
  alt?: string;
  className?: string;
  imageClassName?: string;
};

export default function VisualStateArtwork({
  name,
  category = 'empty-states',
  alt = '',
  className,
  imageClassName,
}: VisualStateArtworkProps) {
  const base = `/visuals/${category}/${name}`;
  const imageClasses = cn('h-full w-full object-contain', imageClassName);
  return (
    <div className={cn('pointer-events-none select-none overflow-hidden', className)} aria-hidden={alt ? undefined : true}>
      <img src={`${base}-light.webp`} alt={alt} className={cn(imageClasses, 'dark:hidden')} />
      <img src={`${base}-dark.webp`} alt={alt} className={cn(imageClasses, 'hidden dark:block')} />
    </div>
  );
}
