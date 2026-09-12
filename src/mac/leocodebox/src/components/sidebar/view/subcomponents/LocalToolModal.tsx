import { useEffect } from 'react';
import { X } from 'lucide-react';

import { Dialog, DialogContent } from '../../../../shared/view/ui/Dialog';

type LocalToolModalProps = {
  title: string;
  src: string;
  onClose: () => void;
};

export default function LocalToolModal({ title, src, onClose }: LocalToolModalProps) {
  useEffect(() => {
    // Esc pressed inside the iframe never reaches this window; the embedded
    // page relays it as a same-origin close message instead.
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if ((event.data as { type?: string } | null)?.type === 'leocodebox-switch:close') onClose();
    };
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [onClose]);

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent aria-label={title} className="leocodebox-settings-dialog flex h-[min(90dvh,900px)] w-[calc(100%-2rem)] max-w-7xl flex-col overflow-hidden border-border/70 bg-background shadow-elevation-3">
      <div className="leocodebox-main-header flex h-14 shrink-0 items-center justify-between border-b border-border/70 px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <img src="/logo-32.png" alt="leocodebox" className="h-7 w-7 rounded-md" />
          <div className="min-w-0">
            <strong className="block truncate text-sm font-semibold text-foreground">leocodebox</strong>
            <span className="block truncate text-[11px] text-muted-foreground">{title}</span>
          </div>
        </div>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onClose}
          aria-label={title}
          title={title}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <iframe className="min-h-0 flex-1 border-0 bg-background" src={src} title={title} allow="clipboard-write" />
      </DialogContent>
    </Dialog>
  );
}
