import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Code2, Download, Eye, PencilLine } from "lucide-react";
import { HTML_ARTIFACT_MAX_BYTES, type HtmlArtifactPreviewHandle } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
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
  const interactive = interactiveContent === content;
  const [saving, setSaving] = useState(false);
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
  const download = async () => {
    if (saving) return;
    setSaving(true);
    const name = (sourcePath ?? title).split(/[\\/]/).at(-1) || "artifact.html";
    const suggestedName = /\.html?$/i.test(name) ? name : `${name}.html`;
    try {
      if (platform?.saveFile) {
        const data = new TextEncoder().encode(content);
        const result = await platform.saveFile({ data: data.buffer as ArrayBuffer, suggestedName });
        if (result.canceled) return;
        if (!result.success) throw new Error(result.error || (zh ? "保存失败" : "Save failed"));
      } else {
        const url = URL.createObjectURL(new Blob([content], { type: "text/html;charset=utf-8" }));
        const link = window.document.createElement("a");
        link.href = url;
        link.download = suggestedName;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      toast(zh ? "HTML 文件已保存" : "HTML saved");
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : zh
            ? "保存失败，请重试"
            : "Could not save. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };
  const refine = () => {
    if (!workspacePath) return;
    const prompt = zh
      ? `请继续修改 HTML 文件 ${sourcePath ?? title}，保留已有内容与用户修改。默认保持单文件，CSS/JS全部内联，不引用外部CDN、字体、图片；用户明确要求项目时遵循其现有技术栈。完成后重新检查页面与交互。我的修改要求是：`
      : `Refine the HTML file ${sourcePath ?? title}. Preserve existing work and user edits, then check its layout and interactions. My requested changes are:`;
    useZCodeSessionStore
      .getState()
      .requestComposerTextInsert(
        workspacePath,
        prompt,
        workspaceIdentity,
        undefined,
        "append-if-missing",
        targetSessionId,
      );
    toast(
      zh
        ? "修改要求已加入任务草稿，补充后发送"
        : "Added to the task draft. Add your changes and send.",
    );
  };
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
          {workspacePath && sourcePath && targetSessionId !== undefined ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={refine}
              data-testid="leo-html-refine"
              className="h-8 gap-1.5 text-ui-sm"
            >
              <PencilLine className="size-3.5" />
              {zh ? "继续修改" : "Refine"}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="default"
            disabled={saving}
            onClick={() => void download()}
            data-testid="leo-html-download"
            className="h-8 gap-1.5 text-ui-sm"
          >
            <Download className="size-3.5" />
            {zh ? "下载 HTML" : "Download HTML"}
          </Button>
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
