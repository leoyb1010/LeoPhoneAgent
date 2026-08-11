import { AlertTriangle, Save } from 'lucide-react';

type OverwriteConfirmModalProps = {
  isOpen: boolean;
  fileName: string;
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export default function OverwriteConfirmModal({
  isOpen,
  fileName,
  saving,
  onCancel,
  onConfirm,
}: OverwriteConfirmModalProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
      <button type="button" aria-label="Close overwrite confirmation" className="fixed inset-0 bg-black/50" onClick={onCancel} />

      <div className="relative w-full max-w-md rounded-lg border border-border bg-card shadow-elevation-3 dark:border-border dark:bg-muted">
        <div className="p-6">
          <div className="mb-4 flex items-center">
            <div className="mr-3 rounded-full bg-warning p-2 dark:bg-warning">
              <AlertTriangle className="h-5 w-5 text-warning dark:text-warning" />
            </div>
            <h3 className="text-lg font-semibold text-muted-foreground dark:text-primary-foreground">File Already Exists</h3>
          </div>

          <p className="mb-6 text-sm text-muted-foreground dark:text-muted-foreground">
            A PRD named "{fileName}" already exists. Do you want to overwrite it?
          </p>

          <div className="flex justify-end gap-3">
            <button
              onClick={onCancel}
              disabled={saving}
              className="rounded-md border border-border bg-card px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted dark:border-border dark:bg-muted dark:text-muted-foreground dark:hover:bg-muted"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={saving}
              className="flex items-center gap-2 rounded-md bg-warning px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-warning disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              <span>{saving ? 'Saving...' : 'Overwrite'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
