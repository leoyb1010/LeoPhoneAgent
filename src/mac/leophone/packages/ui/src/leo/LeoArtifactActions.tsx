import { useState } from "react";
import { Download, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

export function LeoArtifactActions({ format, content, title, sourcePath, workspacePath, workspaceIdentity, targetSessionId }: {
  format: "HTML" | "Markdown";
  content: string;
  title: string;
  sourcePath?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  targetSessionId?: string | null;
}) {
  const platform = useOptionalPlatform();
  const { locale } = useZCodeIntl();
  const zh = locale.startsWith("zh");
  const [saving, setSaving] = useState(false);
  const html = format === "HTML";
  const download = async () => {
    if (saving) return;
    setSaving(true);
    const name = (sourcePath ?? title).split(/[\\/]/).at(-1) || "artifact";
    const extension = html ? "html" : "md";
    const matches = html ? /\.html?$/i.test(name) : /\.(md|markdown|mdown|mkd)$/i.test(name);
    const suggestedName = matches || (!html && sourcePath) ? name : `${name}.${extension}`;
    try {
      if (platform?.saveFile) {
        const data = new TextEncoder().encode(content);
        const result = await platform.saveFile({ data: data.buffer as ArrayBuffer, suggestedName });
        if (result.canceled) return;
        if (!result.success) throw new Error(result.error || (zh ? "保存失败" : "Save failed"));
      } else {
        const url = URL.createObjectURL(new Blob([content], { type: html ? "text/html;charset=utf-8" : "text/markdown;charset=utf-8" }));
        const link = window.document.createElement("a");
        link.href = url;
        link.download = suggestedName;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      toast(zh ? `${format} 文件已保存` : `${format} saved`);
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
      ? `请继续修改 ${format} 文件 ${sourcePath ?? title}，保留已有内容与用户修改。我的修改要求是：`
      : `Refine the ${format} file ${sourcePath ?? title}. Preserve existing work and user edits. My requested changes are:`;
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
    <>
          {workspacePath && sourcePath && targetSessionId !== undefined ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={refine}
              data-testid={html ? "leo-html-refine" : "leo-markdown-refine"}
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
            data-testid={html ? "leo-html-download" : "leo-markdown-download"}
            className="h-8 gap-1.5 text-ui-sm"
          >
            <Download className="size-3.5" />
            {zh ? `下载 ${format}` : `Download ${format}`}
          </Button>
    </>
  );
}
