import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BookOpen, Check, Copy, CornerDownLeft, FileText } from "lucide-react";
import type { LeoBrainSearchScope, LeoBrainWorkspaceData, LeoBrainWorkspaceRequest, LeoBrainWorkspaceResult } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

type ListData = Extract<LeoBrainWorkspaceData, { op: "cards" | "search" }>;
type ReadData = Extract<LeoBrainWorkspaceData, { op: "read" }>;
type Failure = Extract<LeoBrainWorkspaceResult, { ok: false }>["error"];
type ListRequest = Extract<LeoBrainWorkspaceRequest, { op: "cards" | "search" }>;

const BRAIN_SCOPES: readonly LeoBrainSearchScope[] = ["all", "files", "cards"];

function extractBrainDetailPlainText(detail: ReadData): string {
  const parts: string[] = [];
  if (detail.title?.trim()) parts.push(detail.title.trim());
  if (detail.kind === "card") {
    if (detail.body?.trim()) parts.push(detail.body.trim());
  } else {
    if (detail.summary?.trim()) parts.push(detail.summary.trim());
    for (const chunk of detail.chunks) {
      if (chunk.locator?.trim()) parts.push(`[${chunk.locator.trim()}]`);
      if (chunk.text?.trim()) parts.push(chunk.text.trim());
    }
  }
  return parts.join("\n\n");
}

function buildBrainComposerCitation(detail: ReadData, fallbackTitle: string): string {
  const title = detail.title?.trim() || fallbackTitle;
  const body =
    detail.kind === "card"
      ? detail.body.trim()
      : [detail.summary?.trim(), ...detail.chunks.map((c) => c.text.trim())]
          .filter(Boolean)
          .join("\n\n");
  const excerpt = body.length > 1600 ? `${body.slice(0, 1600)}…` : body;
  return excerpt ? `> 【${title}】\n> ${excerpt.replace(/\n/g, "\n> ")}\n\n` : `> 【${title}】\n\n`;
}

/** Read-only workspace. UI owns selection; Host owns validation, auth and gateway I/O. */
export function LeoBrainWorkspace({
  open,
  onOpenChange,
  workspacePath,
  workspaceIdentity,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath?: string;
  workspaceIdentity?: string;
}) {
  const port = usePlatform().leoBrain;
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `brain.workspace.${key}` });
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<LeoBrainSearchScope>("all");
  const [list, setList] = useState<ListData | null>(null);
  const [detail, setDetail] = useState<ReadData | null>(null);
  const [selected, setSelected] = useState<{ kind: "card" | "file"; id: string } | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const [listBusy, setListBusy] = useState(false);
  const [readBusy, setReadBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [copied, setCopied] = useState(false);
  const [inserted, setInserted] = useState(false);
  const listEpoch = useRef(0);
  const readEpoch = useRef(0);
  const retry = useRef<() => void>(() => {});
  const feedbackTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (feedbackTimer.current !== null) {
      window.clearTimeout(feedbackTimer.current);
      feedbackTimer.current = null;
    }
  }, []);

  const loadList = useCallback(async (request: ListRequest): Promise<void> => {
    if (!port) return;
    const epoch = ++listEpoch.current;
    ++readEpoch.current;
    setSelected(null);
    setDetail(null);
    setHighlightedIndex(-1);
    setReadBusy(false);
    setFailure(null);
    setListBusy(true);
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
    setSelected({ kind, id });
    setReadBusy(true);
    setFailure(null);
    setDetail(null);
    setCopied(false);
    setInserted(false);
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
    return () => {
      ++listEpoch.current;
      ++readEpoch.current;
      if (feedbackTimer.current !== null) {
        window.clearTimeout(feedbackTimer.current);
        feedbackTimer.current = null;
      }
    };
  }, [open, loadList]);

  const rows = useMemo(
    () =>
      list?.op === "cards"
        ? list.items.map((item) => ({ kind: "card" as const, id: item.id, title: item.title, excerpt: item.summary }))
        : list?.items.map((item) => ({ kind: item.type, id: item.id, title: item.title, excerpt: item.match?.excerpt })) ?? [],
    [list],
  );

  if (!port) return null;
  const showSetup = failure?.code === "not_configured" || failure?.code === "unauthorized";

  const handleScopeChange = (nextScope: LeoBrainSearchScope) => {
    setScope(nextScope);
    if (query.trim()) {
      void loadList({ op: "search", query: query.trim(), scope: nextScope });
    }
  };

  const handleListKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (listBusy || rows.length === 0) return;
    // Narrow viewport showing reader detail: keep ↑/↓ free for scrolling the article.
    if (
      selected !== null &&
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 767px)").matches
    ) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((prev) => (prev + 1) % rows.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((prev) => (prev <= 0 ? rows.length - 1 : prev - 1));
    } else if (event.key === "Enter" && highlightedIndex >= 0 && highlightedIndex < rows.length) {
      // Never hijack Enter on focused buttons/links/summaries or while submitting a fresh search.
      if (
        event.target instanceof Element &&
        event.target.closest("button, a, summary, textarea, select") !== null
      ) {
        return;
      }
      const target = rows[highlightedIndex]!;
      event.preventDefault();
      void read(target.kind, target.id);
    }
  };

  const handleCopyDetail = () => {
    if (!detail) return;
    const text = extractBrainDetailPlainText(detail);
    if (!text) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
        feedbackTimer.current = window.setTimeout(() => {
          setCopied(false);
          feedbackTimer.current = null;
        }, 1500);
      })
      .catch(() => undefined);
  };

  const handleInsertIntoChat = () => {
    if (!detail || !workspacePath) return;
    const citation = buildBrainComposerCitation(detail, t("untitled"));
    useZCodeSessionStore
      .getState()
      .requestComposerTextInsert(workspacePath, citation, workspaceIdentity, undefined, "append-if-missing");
    setInserted(true);
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => {
      setInserted(false);
      feedbackTimer.current = null;
      onOpenChange(false);
    }, 320);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(85vh,760px)] flex-col gap-3 overflow-hidden sm:max-w-5xl motion-reduce:animate-none!"
        overlayClassName="motion-reduce:animate-none!"
        onKeyDown={handleListKeyDown}
      >
        <div className="pr-10">
          <DialogTitle className="text-ui-lg">{t("title")}</DialogTitle>
          <DialogDescription className="mt-1 text-ui-sm">{t("privacy")}</DialogDescription>
        </div>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (query.trim()) void loadList({ op: "search", query: query.trim(), scope });
          }}
        >
          <Input
            className="min-w-40 flex-1"
            value={query}
            maxLength={200}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlightedIndex(-1);
            }}
            placeholder={t("placeholder")}
            aria-label={t("search")}
          />
          <div
            role="group"
            aria-label={t("scope")}
            className="inline-flex h-8 items-center rounded-lg border border-border bg-surface p-0.5"
          >
            {BRAIN_SCOPES.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={scope === option}
                onClick={() => handleScopeChange(option)}
                className={cn(
                  "h-7 rounded-md px-2.5 text-ui-caption font-medium transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-brand",
                  scope === option
                    ? "bg-background text-foreground shadow-xs"
                    : "text-foreground-subtle hover:text-foreground",
                )}
              >
                {t(option)}
              </button>
            ))}
          </div>
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
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5 text-ui-sm text-foreground">
              <span>{list ? intl.formatMessage({ id: "brain.workspace.total" }, { count: list.total }) : t("results")}</span>
              {rows.length > 0 ? (
                <span className="hidden text-ui-caption text-foreground-subtlest sm:inline">{t("keyboardHint")}</span>
              ) : null}
            </div>
            {listBusy ? (
              <div role="status" aria-label={t("loading")} className="space-y-3 p-3">
                {[0, 1, 2, 3].map((slot) => (
                  <div key={slot} className="space-y-2 rounded-lg border border-border/60 p-3">
                    <div className="h-3.5 w-3/5 rounded bg-surface animate-pulse motion-reduce:animate-none" />
                    <div className="h-3 w-full rounded bg-surface animate-pulse motion-reduce:animate-none" />
                    <div className="h-3 w-4/5 rounded bg-surface animate-pulse motion-reduce:animate-none" />
                  </div>
                ))}
              </div>
            ) : rows.length === 0 && !failure ? (
              <p className="p-4 text-ui-base text-foreground-subtle">{t("empty")}</p>
            ) : null}
            {!listBusy ? rows.map((item, index) => {
              const isSelected = selected?.id === item.id && selected?.kind === item.kind;
              const isHighlighted = highlightedIndex === index;
              return (
                <button
                  type="button"
                  key={`${item.kind}:${item.id}`}
                  className={cn(
                    "block w-full border-b border-border px-3 py-3 text-left text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] motion-reduce:transition-none",
                    isSelected && "bg-accent/50",
                    !isSelected && isHighlighted && "bg-surface-hover",
                  )}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onClick={() => {
                    setHighlightedIndex(index);
                    void read(item.kind, item.id);
                  }}
                  aria-pressed={isSelected}
                >
                  <span className="flex items-start gap-2 text-ui-base font-medium">
                    {item.kind === "card" ? <BookOpen aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand" /> : <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />}
                    <span className="break-words">{item.title || t("untitled")}</span>
                  </span>
                  {item.excerpt ? <span className="mt-1 block line-clamp-3 text-ui-sm text-foreground-subtle">{item.excerpt}</span> : null}
                </button>
              );
            }) : null}
            {list?.op === "search" && list.hiddenSensitive > 0 ? <p className="p-3 text-ui-sm text-foreground-subtle">{t("hidden")}</p> : null}
            {list?.nextOffset != null ? <Button variant="outline" className="m-3" disabled={listBusy} onClick={() => void loadList(list.op === "cards" ? { op: "cards", offset: list.nextOffset! } : { op: "search", query: list.query, scope: list.scope, offset: list.nextOffset! })}>{t("next")}</Button> : null}
          </section>
          <section aria-label={t("reader")} aria-busy={readBusy} className={`min-h-0 overflow-y-auto rounded-lg border border-border p-4 ${selected ? "block" : "hidden md:block"}`}>
            {selected ? <Button variant="ghost" className="mb-3 md:hidden" onClick={() => { ++readEpoch.current; setSelected(null); setReadBusy(false); setFailure(null); }}><ArrowLeft aria-hidden="true" />{t("back")}</Button> : null}
            {readBusy ? (
              <div role="status" aria-label={t("loading")} className="max-w-[680px] space-y-3">
                <div className="h-5 w-2/3 rounded bg-surface animate-pulse motion-reduce:animate-none" />
                <div className="h-3 w-1/3 rounded bg-surface animate-pulse motion-reduce:animate-none" />
                <div className="mt-5 space-y-2.5">
                  <div className="h-3.5 w-full rounded bg-surface animate-pulse motion-reduce:animate-none" />
                  <div className="h-3.5 w-11/12 rounded bg-surface animate-pulse motion-reduce:animate-none" />
                  <div className="h-3.5 w-5/6 rounded bg-surface animate-pulse motion-reduce:animate-none" />
                </div>
              </div>
            ) : detail ? (
              <div className="max-w-[680px]">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <h2 className="break-words text-ui-lg font-semibold">{detail.title || t("untitled")}</h2>
                    <p className="mt-1 text-ui-sm text-foreground-subtle tabular-nums">
                      {detail.kind === "card"
                        ? intl.formatMessage({ id: "brain.workspace.cardPage" }, { start: detail.bodyOffset, end: detail.bodyOffset + detail.body.length, total: detail.bodyLength })
                        : intl.formatMessage({ id: "brain.workspace.filePage" }, { start: detail.chunks.length ? detail.chunkOffset + 1 : detail.chunkOffset, end: detail.chunkOffset + detail.chunks.length, total: detail.chunkTotal })}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {workspacePath ? (
                      <Button type="button" variant="secondary" size="sm" onClick={handleInsertIntoChat}>
                        {inserted ? <Check aria-hidden="true" className="mr-1.5 size-3.5" /> : <CornerDownLeft aria-hidden="true" className="mr-1.5 size-3.5" />}
                        {inserted ? t("insertedToChat") : t("insertToChat")}
                      </Button>
                    ) : null}
                    <Button type="button" variant="outline" size="sm" onClick={handleCopyDetail}>
                      {copied ? <Check aria-hidden="true" className="mr-1.5 size-3.5" /> : <Copy aria-hidden="true" className="mr-1.5 size-3.5" />}
                      {copied ? t("copied") : t("copy")}
                    </Button>
                  </div>
                </div>
                {detail.kind === "card" ? <div className="mt-4 whitespace-pre-wrap break-words text-ui-base leading-relaxed select-text">{detail.body || t("noText")}</div> : <>{detail.summary ? <p className="mt-4 text-ui-base select-text">{detail.summary}</p> : null}{detail.chunks.map((chunk) => <section key={chunk.id} className="mt-5">{chunk.locator ? <h3 className="mb-2 text-ui-sm font-medium text-foreground-subtle">{chunk.locator}</h3> : null}<p className="whitespace-pre-wrap break-words text-ui-base leading-relaxed select-text">{chunk.text}</p></section>)}{detail.chunks.length === 0 ? <p className="mt-4 text-ui-base">{t("noText")}</p> : null}</>}
                {detail.kind === "card" && detail.sources.length > 0 ? <div className="mt-6 border-t border-border pt-3"><h3 className="text-ui-sm font-medium">{t("sources")}</h3>{detail.sources.map((source, index) => <Button key={`${source.fileId}:${index}`} variant="outline" className="mt-2 mr-2 max-w-full" onClick={() => void read("file", source.fileId)}><span className="truncate">{source.locator || t("sourceFile")}</span></Button>)}</div> : null}
                {detail.nextOffset != null ? <Button variant="outline" className="mt-5" onClick={() => void read(detail.kind, detail.id, detail.nextOffset!)}>{t("continue")}</Button> : null}
              </div>
            ) : !failure ? <p className="text-ui-base text-foreground-subtle">{t("select")}</p> : null}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
