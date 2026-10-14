/* New task 草稿页推荐提示词入口。
   推荐配置来自 Client Scenes 的 draft-suggestion scene。 */
import type { CSSProperties } from "react";
import { Check, Info, LoaderCircle, SquareCode, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ClientSceneLucideIcon } from "@/components/ClientSceneLucideIcon.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  resolveDraftSuggestedPromptText,
  type DraftSuggestedPromptItem,
} from "@/v4/draftSuggestedPromptItems.js";
import type { DraftSuggestedPluginActionPopoverState } from "@/v4/useDraftSuggestedPluginActionPopover.js";

export type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

const PLUGIN_SUCCESS_ROLL_TRANSITION = {
  duration: 0.2,
  ease: [0.4, 0, 0.2, 1],
} as const;

function DraftSuggestedPromptIcon({ name }: { name?: string }) {
  return (
    <ClientSceneLucideIcon
      name={name}
      aria-hidden="true"
      className="size-4"
      strokeWidth={2}
      fallback={<SquareCode aria-hidden="true" className="size-4" strokeWidth={2} />}
    />
  );
}

interface ConversationDraftSuggestedPromptsProps {
  className?: string;
  /** 推荐项列表；由上层从 Client Scenes 映射后下发。 */
  items?: DraftSuggestedPromptItem[];
  /** 点击回调；完整配置交给上层解析 prompt 与 Plugin catalog。 */
  onSelect?: (item: DraftSuggestedPromptItem) => void;
  disabled?: boolean;
  pluginActionPopover?: DraftSuggestedPluginActionPopoverState | null;
}

function DraftSuggestedPluginActionPopoverContent({
  state,
}: {
  state: DraftSuggestedPluginActionPopoverState;
}) {
  const isConfirmation = state.phase === "confirmation";
  const reducedMotion = useReducedMotion();
  const statusIcon =
    state.phase === "progress" ? (
      <LoaderCircle
        aria-hidden="true"
        className="size-4 shrink-0 animate-spin text-foreground-subtle motion-reduce:animate-none"
      />
    ) : state.phase === "success" ? (
      <Check
        aria-hidden="true"
        data-draft-suggested-plugin-success-icon="true"
        className="size-4 shrink-0 text-foreground"
      />
    ) : state.phase === "error" ? (
      <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warning" />
    ) : (
      <Info aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />
    );
  const statusContent = (
    <>
      {statusIcon}
      <div
        data-draft-suggested-plugin-popover-message="true"
        className="min-w-0 flex-1 text-ui-base leading-4.5 text-foreground"
      >
        {state.message}
      </div>
    </>
  );

  return (
    <PopoverContent
      side="bottom"
      align="center"
      sideOffset={6}
      collisionPadding={16}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      onEscapeKeyDown={(event) => event.preventDefault()}
      onFocusOutside={(event) => event.preventDefault()}
      onPointerDownOutside={(event) => {
        const isPrimaryPointer = event.detail.originalEvent.button === 0;
        if (!isConfirmation || !state.onDismiss || !isPrimaryPointer) {
          event.preventDefault();
          return;
        }
        state.onDismiss();
      }}
      data-draft-suggested-plugin-popover={state.phase}
      data-draft-suggested-plugin-popover-offset="9"
      data-anchor-item-id={state.anchorItemId}
      className={cn(
        // 固定 80px 确认态只容得下一行标题，较长的本地化 Plugin 名称换行后会把按钮挤出并被裁切。
        "h-auto w-60 max-w-[calc(100vw-2rem)] border-popover-border bg-popover p-3 shadow-md",
        isConfirmation ? "gap-3" : "gap-0",
      )}
    >
      {/* Plugin 名称、状态和按钮不压进同一横排、不从锚点上方展开：遵循设计稿的确认/结果两种结构。 */}
      <div
        role={state.phase === "error" ? "alert" : "status"}
        aria-live={state.phase === "error" ? "assertive" : "polite"}
        data-draft-suggested-plugin-status-viewport="true"
        className="relative min-w-0 overflow-hidden"
      >
        {reducedMotion ? (
          <div
            data-draft-suggested-plugin-success-content={
              state.phase === "success" ? "true" : undefined
            }
            className="flex min-w-0 items-center gap-1.5"
          >
            {statusContent}
          </div>
        ) : (
          // 旧 CSS rotateX 只让成功内容自身翻入，无法像模型标签一样表达“进度被成功替换”。
          // steady key 覆盖确认、进度、失败和重试，仅在进入成功态时触发一出一入的纵向滚动。
          <AnimatePresence initial={false} mode="popLayout">
            <motion.div
              key={state.phase === "success" ? "success" : "steady"}
              data-draft-suggested-plugin-success-content={
                state.phase === "success" ? "true" : undefined
              }
              className="flex min-w-0 items-center gap-1.5"
              initial={{ y: "0.75em", opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: "-0.75em", opacity: 0 }}
              transition={PLUGIN_SUCCESS_ROLL_TRANSITION}
            >
              {statusContent}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
      {isConfirmation && state.actionLabel && state.onAction ? (
        <Button
          type="button"
          size="sm"
          variant="default"
          className="self-end"
          onClick={state.onAction}
        >
          {state.actionLabel}
        </Button>
      ) : null}
    </PopoverContent>
  );
}

export function ConversationDraftSuggestedPrompts({
  className,
  items = [],
  onSelect,
  disabled = false,
  pluginActionPopover,
}: ConversationDraftSuggestedPromptsProps) {
  const { locale } = useZCodeIntl();

  if (items.length === 0) return null;

  return (
    <div
      data-v4-draft-suggested-prompts="true"
      className={cn(
        "w-full min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      <div
        data-v4-draft-suggested-prompts-group="true"
        className="mx-auto flex w-max items-center gap-4"
      >
        {items.map((item, index) => {
          const label = resolveDraftSuggestedPromptText(item.label, locale);
          const isPopoverAnchor = pluginActionPopover?.anchorItemId === item.id;
          return (
            <Popover key={item.id} open={isPopoverAnchor} modal={false}>
              {/* 只在 Popover 打开时才包 Root/Anchor 会重挂按钮并重播 waterfall，
                  Radix 因而连续测量到带 translateY 的锚点。所有推荐项从首次渲染起保持同一结构。 */}
              <PopoverAnchor
                asChild
                data-slot="button"
                data-draft-suggested-plugin-popover-anchor={isPopoverAnchor ? "true" : undefined}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  data-draft-suggested-prompt={item.id}
                  aria-label={label}
                  title={label}
                  disabled={!onSelect || disabled}
                  onClick={onSelect ? () => onSelect(item) : undefined}
                  className="zcode-draft-prompt-waterfall h-8 min-w-0 justify-start gap-1.5 overflow-hidden rounded-lg px-3 text-left text-ui-caption font-normal leading-4.5 text-foreground"
                  style={
                    {
                      "--zcode-draft-prompt-waterfall-delay": `${index * 65}ms`,
                    } as CSSProperties
                  }
                >
                  <span
                    data-draft-suggested-prompt-icon="true"
                    className="flex size-4 shrink-0 items-center justify-center text-foreground opacity-70 transition-opacity group-hover/button:opacity-100 motion-reduce:transition-none"
                  >
                    <DraftSuggestedPromptIcon name={item.iconName} />
                  </span>
                  <span
                    data-draft-suggested-prompt-text="true"
                    className="min-w-0 max-w-64 truncate text-ui-base text-foreground opacity-70 transition-opacity group-hover/button:opacity-100 motion-reduce:transition-none"
                  >
                    {label}
                  </span>
                </Button>
              </PopoverAnchor>
              {isPopoverAnchor ? (
                <DraftSuggestedPluginActionPopoverContent state={pluginActionPopover} />
              ) : null}
            </Popover>
          );
        })}
      </div>
    </div>
  );
}
