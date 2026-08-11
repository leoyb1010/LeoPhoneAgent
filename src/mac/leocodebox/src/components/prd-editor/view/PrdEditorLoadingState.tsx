export default function PrdEditorLoadingState() {
  return (
    <div className="fixed inset-0 z-[200] md:flex md:items-center md:justify-center md:bg-black/50">
      <div className="flex h-full w-full items-center justify-center bg-card p-8 dark:bg-muted md:h-auto md:w-auto md:rounded-lg">
        <div className="flex items-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-info" />
          <span className="text-muted-foreground dark:text-primary-foreground">Loading PRD...</span>
        </div>
      </div>
    </div>
  );
}
