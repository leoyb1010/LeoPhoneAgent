import { Sparkles, X } from 'lucide-react';

type CreateTaskModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export default function CreateTaskModal({ isOpen, onClose }: CreateTaskModalProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border border-border bg-card shadow-elevation-3 dark:border-border dark:bg-muted">
        <div className="flex items-center justify-between border-b border-border p-6 dark:border-border">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-info dark:bg-info/50">
              <Sparkles className="h-4 w-4 text-info dark:text-info" />
            </div>
            <h3 className="text-lg font-semibold text-muted-foreground dark:text-primary-foreground">Create AI-Generated Task</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted dark:hover:text-muted-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-6 p-6">
          <div className="rounded-lg border border-info bg-info p-4 dark:border-info dark:bg-info/20">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-info dark:bg-info/50">
                <Sparkles className="h-4 w-4 text-info dark:text-info" />
              </div>
              <div>
                <h4 className="mb-2 font-semibold text-info dark:text-info">Pro tip: ask Claude Code directly</h4>
                <p className="mb-3 text-sm text-info dark:text-info">
                  Ask for a task in chat with context and requirements. TaskMaster can generate implementation-ready tasks.
                </p>
                <div className="rounded-md border border-info bg-card p-3 dark:border-info dark:bg-muted">
                  <p className="mb-1 text-xs font-medium text-muted-foreground dark:text-muted-foreground">Example:</p>
                  <p className="font-mono text-sm text-muted-foreground dark:text-primary-foreground">
                    Please add a task for profile image uploads and include best-practice research.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="border-t border-border pt-4 text-center dark:border-border">
            <a
              href="https://github.com/eyaltoledano/claude-task-master/blob/main/docs/examples.md"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-sm font-medium text-info underline hover:text-info dark:text-info dark:hover:text-info"
            >
              View TaskMaster documentation
            </a>
          </div>

          <button
            onClick={onClose}
            className="w-full rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted dark:border-border dark:bg-muted dark:text-muted-foreground dark:hover:bg-muted"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
