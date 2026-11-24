import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Code2, Eye } from "lucide-react";
import { HTML_ARTIFACT_MAX_BYTES, type HtmlArtifactPreviewHandle } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { LeoArtifactActions } from "./LeoArtifactActions.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildLeoHtmlPreviewDocument } from "./htmlArtifactPolicy.js";

export function LeoHtmlPreview({
  content,
  title,
  sourcePath,
  sourceView,
  workspacePath,
  workspaceIdentity,
  targetSessionId,
}: {
  content: string;
  title: string;
  sourcePath?: string;
  sourceView: ReactNode;
  workspacePath?: string;
  workspaceIdentity?: string;
  targetSessionId?: string | null;
}) {
  const { locale } = useZCodeIntl();
  const zh = locale.startsWith("zh");
  const platform = useOptionalPlatform();
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const [interactiveContent, setInteractiveContent] = useState<string | null>(null);
  // 文件改回旧文本也是新版本，不能自动恢复曾经允许的脚本。
  if (interactiveContent !== null && interactiveContent !== content) setInteractiveContent(null);
  const interactive = interactiveContent === content;
  const document = useMemo(() => buildLeoHtmlPreviewDocument(content, false), [content]);
  const previewPort = platform?.htmlPreview;
  const previewTooLarge = new TextEncoder().encode(content).byteLength > HTML_ARTIFACT_MAX_BYTES;
  const [retry, setRetry] = useState(0);
  const [nativePreview, setNativePreview] = useState<{
    content: string;
    interactive: boolean;
    handle?: HtmlArtifactPreviewHandle;
    error?: string;
  } | null>(null);
  const matchedPreview =
    nativePreview?.content === content && nativePreview.interactive === interactive
      ? nativePreview
      : null;
  useEffect(() => {
    if (!previewPort || mode !== "preview" || previewTooLarge) return;
    let disposed = false;
    let created: HtmlArtifactPreviewHandle | undefined;
    const release = (handle: HtmlArtifactPreviewHandle) => {
      void previewPort.release(handle.id).catch(() => undefined);
    };
    setNativePreview(null);
    void previewPort
      .create({ html: content, interactive })
      .then((handle) => {
        created = handle;
        if (disposed) release(handle);
        else setNativePreview({ content, interactive, handle });
      })
      .catch((error: unknown) => {
        if (!disposed)
          setNativePreview({
            content,
            interactive,
            error:
              error instanceof Error && error.message.includes("capacity")
                ? zh
                  ? "预览过多，请关闭其他预览后重试。"
                  : "Too many previews. Close another and retry."
                : zh
                  ? "暂时无法准备预览，请重试或查看源码。"
                  : "Could not prepare preview. Retry or view the source.",
          });
      });
    return () => {
      disposed = true;
      if (created) release(created);
    };
  }, [content, interactive, mode, previewPort, previewTooLarge, retry, zh]);
  return (
    <section
      className="leo-html-artifact flex h-full min-h-0 flex-col bg-background"
      aria-label={zh ? "HTML 产物" : "HTML artifact"}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div
          role="group"
          aria-label={zh ? "HTML 视图" : "HTML view"}
          className="flex items-center gap-1 rounded-lg bg-surface p-1"
        >
          <Button
            size="sm"
            variant={mode === "preview" ? "secondary" : "ghost"}
            onClick={() => setMode("preview")}
            aria-pressed={mode === "preview"}
            data-testid="leo-html-preview-tab"
            className="h-8 gap-1.5 text-ui-sm"
          >
            <Eye className="size-3.5" />
            {zh ? "预览" : "Preview"}
          </Button>
          <Button
            size="sm"
            variant={mode === "code" ? "secondary" : "ghost"}
            onClick={() => {
              setNativePreview(null);
              setMode("code");
            }}
            aria-pressed={mode === "code"}
            data-testid="leo-html-source-tab"
            className="h-8 gap-1.5 text-ui-sm"
          >
            <Code2 className="size-3.5" />
            {zh ? "源码" : "Source"}
          </Button>
        </div>
        <div className="flex items-center gap-1">
          {mode === "preview" && previewPort ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={!matchedPreview?.handle}
              onClick={() => setInteractiveContent(interactive ? null : content)}
              data-testid="leo-html-run"
              aria-pressed={interactive}
              className="h-8 text-ui-sm"
            >
              {interactive ? (zh ? "停止交互" : "Stop scripts") : zh ? "运行交互" : "Run scripts"}
            </Button>
          ) : null}
          <LeoArtifactActions format="HTML" content={content} title={title} sourcePath={sourcePath}
            workspacePath={workspacePath} workspaceIdentity={workspaceIdentity} targetSessionId={targetSessionId} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === "code" ? (
          sourceView
        ) : previewPort && !matchedPreview?.handle ? (
          <div
            className="flex h-full min-h-80 flex-col items-center justify-center gap-3 p-5 text-ui-sm text-foreground-subtle"
            role={matchedPreview?.error ? "alert" : "status"}
          >
            <p>
              {previewTooLarge
                ? zh
                  ? "文件较大，请查看源码或下载 HTML。"
                  : "This file is too large to preview. View its source or download HTML."
                : (matchedPreview?.error ?? (zh ? "正在准备预览…" : "Preparing preview…"))}
            </p>
            {!previewTooLarge && matchedPreview?.error ? (
              <Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}>
                {zh ? "重试预览" : "Retry preview"}
              </Button>
            ) : null}
          </div>
        ) : (
          <iframe
            key={matchedPreview?.handle?.id ?? content}
            name="leo-html-preview"
            title={title}
            data-testid="leo-html-frame"
            sandbox={previewPort && interactive ? "allow-scripts" : ""}
            referrerPolicy="no-referrer"
            src={matchedPreview?.handle?.url}
            srcDoc={previewPort ? undefined : document}
            className="h-full min-h-80 w-full border-0 bg-white"
          />
        )}
      </div>
      <p className="shrink-0 border-t border-border px-3 py-1.5 text-ui-xs leading-relaxed text-foreground-subtle">
        {zh
          ? "静态预览默认不运行脚本；运行交互仅对当前版本生效。外部资源被阻断。"
          : "Scripts are off by default. Run scripts applies to this version only. External resources are blocked."}
      </p>
    </section>
  );
}
