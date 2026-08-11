type StandaloneShellHeaderProps = {
  title: string;
  isCompleted: boolean;
  onClose?: (() => void) | null;
};

export default function StandaloneShellHeader({
  title,
  isCompleted,
  onClose = null,
}: StandaloneShellHeaderProps) {
  return (
    <div className="flex-shrink-0 border-b border-border bg-muted px-4 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
          {isCompleted && <span className="text-xs text-success">(Completed)</span>}
        </div>

        {onClose && (
          <button onClick={onClose} className="text-muted-foreground hover:text-primary-foreground" title="Close">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
