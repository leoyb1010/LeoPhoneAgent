import { ConversationUserInputEpilogue } from "@/v4/ConversationUserInputEpilogue.js";
import { ConversationUserInputBody } from "@/v4/ConversationUserInputBody.js";
import { ConversationUserInputContent } from "@/v4/ConversationUserInputContent.js";

/** 用户输入气泡：正文 + 尾注。 */
export function ConversationUserInputBubble({
  text,
  rowId,
  attachments,
  contextAttachmentCount,
  epilogue,
}: {
  text: string;
  rowId: string | number;
  attachments?: readonly unknown[];
  contextAttachmentCount?: number;
  epilogue?: string;
}) {
  if (!text.trim() && epilogue === undefined) return null;
  return (
    <div
      data-v4-user-input-bubble="true"
      className="flex max-w-full flex-col gap-2 rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3 text-ui-base text-foreground @min-[624px]/conversation:max-w-xl"
    >
      {text.trim() ? (
        <ConversationUserInputBody contentText={text} rowId={rowId}>
          <ConversationUserInputContent
            text={text}
            attachments={attachments}
            contextAttachmentCount={contextAttachmentCount}
          />
        </ConversationUserInputBody>
      ) : null}
      {epilogue === undefined ? null : <ConversationUserInputEpilogue text={epilogue} />}
    </div>
  );
}
