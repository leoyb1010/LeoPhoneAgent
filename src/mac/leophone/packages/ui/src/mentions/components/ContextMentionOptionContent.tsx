import { MessagesSquare } from "lucide-react";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import type { MentionItem } from "@/mentions/mentionTypes.js";

export function ContextMentionOptionContent({
  item,
  workspacePath,
}: {
  item: MentionItem;
  workspacePath: string;
}) {
  return item.category === "files" ? (
    <FileDisplayInline
      path={item.data?.path ?? item.data?.relativePath ?? item.value}
      options={{
        basePath: workspacePath,
        kind: item.data?.kind,
        showFilePath: true,
      }}
    />
  ) : (
    <span className="min-w-0 flex flex-1 items-center gap-2">
      <MessagesSquare className="size-3.5 shrink-0 text-foreground" />
      <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
        {item.label}
      </span>
      <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
        {item.description}
      </span>
    </span>
  );
}
