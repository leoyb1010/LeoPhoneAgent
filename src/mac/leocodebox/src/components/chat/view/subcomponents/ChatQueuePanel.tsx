import type { ChatQueueItem } from '../../../../../shared/chat-session-protocol';

export type ChatQueuePanelProps = {
  items: ChatQueueItem[];
  error: string;
  pendingActionIds: ReadonlySet<string>;
  onCancel: (id: string) => void;
  onResume: (id: string) => void;
};

export default function ChatQueuePanel({ items, error, pendingActionIds, onCancel, onResume }: ChatQueuePanelProps) {
  if (items.length === 0 && !error) return null;
  return (
    <section aria-label="待运行任务" className="mx-auto mb-2 w-[calc(100%-2rem)] max-w-[54.25rem] rounded-xl border border-border bg-card">
      {items.length > 0 && <h3 className="border-b border-border px-3 py-2 text-xs font-semibold text-muted-foreground">待运行 · {items.length}</h3>}
      <ol className="max-h-44 divide-y divide-border overflow-y-auto">
        {items.map((item, index) => {
          const recovered = item.state === 'needs_confirmation';
          const busy = pendingActionIds.has(item.id);
          return (
            <li key={item.id} className="px-3 py-2.5">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 break-words text-sm text-foreground">{item.content}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {recovered ? '服务重启后暂停，等待确认' : `排队第 ${index + 1} 项`}
                    {item.model ? ` · ${item.model}` : ''}{item.attachmentCount > 0 ? ` · ${item.attachmentCount} 个附件` : ''}
                  </p>
                  {item.reason === 'server_restarted_during_run' && (
                    <p className="mt-1 text-xs text-warning">上次运行可能已执行部分步骤，请先核对结果，再决定是否重新发送。</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {recovered && <button type="button" disabled={busy} onClick={() => onResume(item.id)}
                    className="min-h-8 rounded-md px-2 text-xs font-medium text-primary hover:bg-accent disabled:opacity-50">
                    {item.reason === 'server_restarted_during_run' ? '核对后重新发送' : '确认继续'}
                  </button>}
                  <button type="button" disabled={busy} onClick={() => onCancel(item.id)} aria-label={`取消排队任务 ${index + 1}`}
                    className="min-h-8 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">
                    {busy ? '正在确认…' : '取消'}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {error && <p role="alert" className="px-3 py-2 text-xs text-destructive">{error}</p>}
    </section>
  );
}
