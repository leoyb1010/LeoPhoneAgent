import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, BookOpen, FileText, Loader2 } from "lucide-react";
import type { LeoBrainSearchScope, LeoBrainWorkspaceData, LeoBrainWorkspaceRequest, LeoBrainWorkspaceResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type ListData = Extract<LeoBrainWorkspaceData, { op: "cards" | "search" }>;
type ReadData = Extract<LeoBrainWorkspaceData, { op: "read" }>;
type Failure = Extract<LeoBrainWorkspaceResult, { ok: false }>["error"];
type ListRequest = Extract<LeoBrainWorkspaceRequest, { op: "cards" | "search" }>;

/** Read-only workspace. UI owns selection; Host owns validation, auth and gateway I/O. */
export function LeoBrainWorkspace({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const port = usePlatform().leoBrain;
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `brain.workspace.${key}` });
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<LeoBrainSearchScope>("all");
  const [list, setList] = useState<ListData | null>(null);
  const [detail, setDetail] = useState<ReadData | null>(null);
  const [selected, setSelected] = useState<{ kind: "card" | "file"; id: string } | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [readBusy, setReadBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const listEpoch = useRef(0);
  const readEpoch = useRef(0);
  const retry = useRef<() => void>(() => {});

  const loadList = useCallback(async (request: ListRequest): Promise<void> => {
    if (!port) return;
    const epoch = ++listEpoch.current;
    ++readEpoch.current;
    setSelected(null); setDetail(null); setReadBusy(false); setFailure(null); setListBusy(true);
    retry.current = () => { void loadList(request); };
    try {
      const result = await port.query(request);
      if (epoch !== listEpoch.current) return;
      if (!result.ok) { setFailure(result.error); setList(null); }
      else if (result.data.op === "cards" || result.data.op === "search") setList(result.data);
      else setFailure({ code: "invalid_response", message: "" });
    } catch {
      if (epoch === listEpoch.current) setFailure({ code: "host_unavailable", message: "" });
    } finally { if (epoch === listEpoch.current) setListBusy(false); }
  }, [port]);

  const read = useCallback(async (kind: "card" | "file", id: string, offset = 0): Promise<void> => {
    if (!port) return;
    const epoch = ++readEpoch.current;
    setSelected({ kind, id }); setReadBusy(true); setFailure(null); setDetail(null);
    retry.current = () => { void read(kind, id, offset); };
    try {
      const result = await port.query({ op: "read", kind, id, offset });
      if (epoch !== readEpoch.current) return;
      if (!result.ok) setFailure(result.error);
      else if (result.data.op === "read") setDetail(result.data);
      else setFailure({ code: "invalid_response", message: "" });
    } catch {
      if (epoch === readEpoch.current) setFailure({ code: "host_unavailable", message: "" });
    } finally { if (epoch === readEpoch.current) setReadBusy(false); }
  }, [port]);

  useEffect(() => {
    if (open) void loadList({ op: "cards" });
    // 关闭或换端口后，旧请求即使返回也不能改当前界面；不轮询、不把正文存盘。
    return () => { ++listEpoch.current; ++readEpoch.current; };
  }, [open, loadList]);

  if (!port) return null;
  const rows = list?.op === "cards"
    ? list.items.map((item) => ({ kind: "card" as const, id: item.id, title: item.title, excerpt: item.summary }))
    : list?.items.map((item) => ({ kind: item.type, id: item.id, title: item.title, excerpt: item.match?.excerpt })) ?? [];
  const showSetup = failure?.code === "not_configured" || failure?.code === "unauthorized";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(85vh,760px)] flex-col gap-3 overflow-hidden sm:max-w-5xl motion-reduce:animate-none!" overlayClassName="motion-reduce:animate-none!">
        <div className="pr-10">
          <DialogTitle className="text-ui-lg">{t("title")}</DialogTitle>
          <DialogDescription className="mt-1 text-ui-sm">{t("privacy")}</DialogDescription>
        </div>
        <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (query.trim()) void loadList({ op: "search", query: query.trim(), scope }); }}>
          <Input className="min-w-40 flex-1" value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} placeholder={t("placeholder")} aria-label={t("search")} />
          <select className="h-8 rounded-md border border-border bg-background px-2 text-ui-base text-foreground" value={scope} onChange={(event) => setScope(event.target.value as LeoBrainSearchScope)} aria-label={t("scope")}>
            <option value="all">{t("all")}</option><option value="files">{t("files")}</option><option value="cards">{t("cards")}</option>
          </select>
          <Button type="submit" variant="secondary" disabled={!query.trim() || listBusy}>{t("search")}</Button>
          <Button type="button" variant="outline" onClick={() => void loadList({ op: "cards" })}>{t("cards")}</Button>
        </form>
        {failure ? (
          <div role="alert" className="rounded-lg border border-border bg-card p-3 text-ui-base text-foreground">
            <p>{t(`error.${failure.code}`)}</p>
            {showSetup ? <p className="mt-2 text-ui-sm">{t("setup")}</p> : null}
            <Button type="button" variant="outline" className="mt-2" onClick={() => retry.current()}>{t("retry")}</Button>
            {showSetup ? <details className="mt-3 text-ui-sm"><summary className="cursor-pointer">{t("advanced")}</summary><p className="mt-2">{t("advancedHelp")}</p><code className="mt-2 block break-all select-text">~/.config/leo-brain/leobot-mac.key</code><p className="mt-2">{t("gatewayHelp")}</p></details> : null}
          </div>
        ) : null}
        <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)]">
          <section aria-label={t("results")} aria-busy={listBusy} className={`min-h-0 overflow-y-auto rounded-lg border border-border ${selected ? "hidden md:block" : "block"}`}>
            <div className="border-b border-border p-3 text-ui-sm text-foreground">{list ? intl.formatMessage({ id: "brain.workspace.total" }, { count: list.total }) : t("results")}</div>
            {listBusy ? <p role="status" className="flex items-center gap-2 p-4 text-ui-base"><Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />{t("loading")}</p> : rows.length === 0 && !failure ? <p className="p-4 text-ui-base">{t("empty")}</p> : null}
            {!listBusy ? rows.map((item) => (
              <button type="button" key={`${item.kind}:${item.id}`} className="block w-full border-b border-border px-3 py-3 text-left text-foreground hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px]" onClick={() => void read(item.kind, item.id)} aria-pressed={selected?.id === item.id && selected?.kind === item.kind}>
                <span className="flex items-start gap-2 text-ui-base font-medium">{item.kind === "card" ? <BookOpen aria-hidden="true" className="mt-0.5 size-4 shrink-0" /> : <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0" />}<span className="break-words">{item.title || t("untitled")}</span></span>
                {item.excerpt ? <span className="mt-1 block line-clamp-3 text-ui-sm">{item.excerpt}</span> : null}
              </button>
            )) : null}
            {list?.op === "search" && list.hiddenSensitive > 0 ? <p className="p-3 text-ui-sm">{t("hidden")}</p> : null}
            {list?.nextOffset != null ? <Button variant="outline" className="m-3" disabled={listBusy} onClick={() => void loadList(list.op === "cards" ? { op: "cards", offset: list.nextOffset! } : { op: "search", query: list.query, scope: list.scope, offset: list.nextOffset! })}>{t("next")}</Button> : null}
          </section>
          <section aria-label={t("reader")} aria-busy={readBusy} className={`min-h-0 overflow-y-auto rounded-lg border border-border p-4 ${selected ? "block" : "hidden md:block"}`}>
            {selected ? <Button variant="ghost" className="mb-3 md:hidden" onClick={() => { ++readEpoch.current; setSelected(null); setReadBusy(false); setFailure(null); }}><ArrowLeft aria-hidden="true" />{t("back")}</Button> : null}
            {readBusy ? <p role="status" className="text-ui-base">{t("loading")}</p> : detail ? <>
              <h2 className="break-words text-ui-lg font-semibold">{detail.title || t("untitled")}</h2>
              <p className="mt-2 text-ui-sm">{detail.kind === "card" ? intl.formatMessage({ id: "brain.workspace.cardPage" }, { start: detail.bodyOffset, end: detail.bodyOffset + detail.body.length, total: detail.bodyLength }) : intl.formatMessage({ id: "brain.workspace.filePage" }, { start: detail.chunks.length ? detail.chunkOffset + 1 : detail.chunkOffset, end: detail.chunkOffset + detail.chunks.length, total: detail.chunkTotal })}</p>
              {detail.kind === "card" ? <div className="mt-4 whitespace-pre-wrap break-words text-ui-base leading-relaxed select-text">{detail.body || t("noText")}</div> : <>{detail.summary ? <p className="mt-4 text-ui-base select-text">{detail.summary}</p> : null}{detail.chunks.map((chunk) => <section key={chunk.id} className="mt-5">{chunk.locator ? <h3 className="mb-2 text-ui-sm font-medium">{chunk.locator}</h3> : null}<p className="whitespace-pre-wrap break-words text-ui-base leading-relaxed select-text">{chunk.text}</p></section>)}{detail.chunks.length === 0 ? <p className="mt-4 text-ui-base">{t("noText")}</p> : null}</>}
              {detail.kind === "card" && detail.sources.length > 0 ? <div className="mt-6 border-t border-border pt-3"><h3 className="text-ui-sm font-medium">{t("sources")}</h3>{detail.sources.map((source, index) => <Button key={`${source.fileId}:${index}`} variant="outline" className="mt-2 mr-2 max-w-full" onClick={() => void read("file", source.fileId)}><span className="truncate">{source.locator || t("sourceFile")}</span></Button>)}</div> : null}
              {detail.nextOffset != null ? <Button variant="outline" className="mt-5" onClick={() => void read(detail.kind, detail.id, detail.nextOffset!)}>{t("continue")}</Button> : null}
            </> : !failure ? <p className="text-ui-base">{t("select")}</p> : null}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
