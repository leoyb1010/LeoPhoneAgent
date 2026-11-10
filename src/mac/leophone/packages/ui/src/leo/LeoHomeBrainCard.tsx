import { Brain } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useLeoHome } from "./LeoHomeContext.js";

export type LeoBrainStatus = { enabled: boolean; cards: number | null; files: number | null; error?: string };
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** 首页和主侧栏都打开同一个只读工作区；UI不再读取原生全局桥。 */
export function LeoHomeBrainCard({ className }: { className?: string }) {
  const port = usePlatform().leoBrain;
  const home = useLeoHome();
  const read = useCallback(async (): Promise<IpcResult<LeoBrainStatus>> => {
    if (!port) return { ok: false, error: "host_unavailable" };
    const result = await port.query({ op: "status" });
    if (result.ok && result.data.op === "status") return { ok: true, data: { enabled: true, cards: result.data.cards, files: result.data.files } };
    if (!result.ok && result.error.code === "not_configured") return { ok: true, data: { enabled: false, cards: null, files: null } };
    return { ok: false, error: "unreachable" };
  }, [port]);
  if (!port) return null;
  return <LeoHomeBrainCardBody read={read} className={className} onOpen={home?.onOpenBrain} />;
}

export function LeoHomeBrainCardBody({ read, className, onOpen }: {
  read: () => Promise<IpcResult<LeoBrainStatus>>; className?: string; onOpen?: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const [status, setStatus] = useState<LeoBrainStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const epoch = useRef(0);
  const load = useCallback(async (): Promise<void> => {
    const current = ++epoch.current;
    setLoading(true);
    try {
      const result = await read();
      if (current !== epoch.current) return;
      setStatus(result.ok ? result.data : { enabled: true, cards: null, files: null, error: result.error });
    } catch {
      if (current === epoch.current) setStatus({ enabled: true, cards: null, files: null, error: "unreachable" });
    } finally { if (current === epoch.current) setLoading(false); }
  }, [read]);
  useEffect(() => { void load(); return () => { ++epoch.current; }; }, [load]);
  const label = loading ? intl.formatMessage({ id: "brain.workspace.loading" })
    : !status?.enabled ? intl.formatMessage({ id: "brain.workspace.error.not_configured" })
    : status.error ? intl.formatMessage({ id: "leoHome.brain.unreachable" })
    : intl.formatMessage({ id: "leoHome.brain.counts" }, {
      cards: status.cards == null ? "—" : new Intl.NumberFormat(locale).format(status.cards),
      files: status.files == null ? "—" : new Intl.NumberFormat(locale).format(status.files),
    });
  return (
    <section aria-label={intl.formatMessage({ id: "leoHome.brain.title" })} data-testid="leo-home-brain" className={cn("leo-home-recent w-full max-w-2xl", className)}>
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2">
        <Brain aria-hidden="true" className="size-4 shrink-0 text-icon-blue" />
        <span className="text-ui-caption font-medium text-foreground">{intl.formatMessage({ id: "leoHome.brain.title" })}</span>
        <span className="min-w-0 flex-1 text-ui-sm text-foreground">{label}</span>
        {status?.error ? <Button variant="ghost" size="xs" disabled={loading} onClick={() => void load()}>{intl.formatMessage({ id: "leoHome.brain.retry" })}</Button> : null}
        {onOpen ? <Button type="button" variant="outline" onClick={onOpen}>{intl.formatMessage({ id: "brain.workspace.open" })}</Button> : null}
      </div>
    </section>
  );
}
