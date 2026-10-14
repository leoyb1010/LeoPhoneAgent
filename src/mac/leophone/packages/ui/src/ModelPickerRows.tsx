import { forwardRef, type KeyboardEvent, type PointerEvent, type SyntheticEvent } from "react";
import { AlertCircle, CheckIcon, SearchIcon, StarIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ModelInputCapabilityBadge } from "@/components/ModelInputCapabilityBadge.js";

export interface ModelPickerRowItem {
  value: string;
  name: string;
  modelId?: string;
  badgeLabel?: string;
  supportsVisionInput?: boolean;
}

export interface ModelPickerPinControl {
  pinned: boolean;
  /** 已满且当前未置顶时禁用星标。 */
  disabled: boolean;
  maxPinned: number;
  onToggle: () => void;
}

const ROW_BADGE_CLASS_NAME =
  "shrink-0 rounded-full bg-surface px-1 py-px text-ui-xs font-medium leading-normal text-foreground-subtle";

function stopMenuEvent(event: SyntheticEvent) {
  // 星标在菜单项内部：Radix Item 在 pointerup 时会主动 click 自身，三类事件都要拦住，否则点星标会顺带选中模型。
  event.preventDefault();
  event.stopPropagation();
}

export function ModelPickerStarButton({ pinned, disabled, maxPinned, onToggle }: ModelPickerPinControl) {
  const { intl } = useZCodeIntl();
  const label = disabled
    ? intl.formatMessage({ id: "chat.toolbar.model.pinnedFull" }, { max: maxPinned })
    : intl.formatMessage({ id: pinned ? "chat.toolbar.model.unpin" : "chat.toolbar.model.pin" });
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      aria-pressed={pinned}
      title={label}
      disabled={disabled}
      data-model-picker-star={pinned ? "pinned" : "unpinned"}
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-md text-foreground-subtlest transition-opacity hover:text-foreground-subtle disabled:cursor-not-allowed disabled:hover:text-foreground-subtlest",
        pinned
          ? "text-warning opacity-100 hover:text-warning"
          : "opacity-0 group-hover/model-row:opacity-100 group-data-[highlighted]/model-row:opacity-100 group-data-[active=true]/model-row:opacity-100",
      )}
      onPointerDown={stopMenuEvent}
      onPointerUp={stopMenuEvent}
      onClick={(event) => {
        stopMenuEvent(event);
        if (!disabled) onToggle();
      }}
    >
      <StarIcon className={cn("size-3.5", pinned && "fill-current")} aria-hidden="true" />
    </button>
  );
}

export function ModelPickerRowLabel({
  item,
  providerLabel,
}: {
  item: ModelPickerRowItem;
  /** 只在拍平列表（搜索结果 / 快速区）里显示所属服务商。 */
  providerLabel?: string;
}) {
  const modelIdHint = item.modelId && item.modelId !== item.name ? item.modelId : undefined;
  const secondary = [providerLabel, modelIdHint].filter(Boolean).join(" · ");
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
      {/* [leo] 名称优先完整显示（最多占七成宽），供应商 · ID 只用剩余空间并截断；
          之前两者同比例收缩，窄菜单里名称会被截成「Leo Fake C…」看不出是哪个模型。 */}
      <span
        className="min-w-0 max-w-[70%] shrink-0 truncate"
        title={modelIdHint ? `${item.name} · ${modelIdHint}` : item.name}
      >
        {item.name}
      </span>
      {item.badgeLabel ? <span className={ROW_BADGE_CLASS_NAME}>{item.badgeLabel}</span> : null}
      {item.supportsVisionInput ? <ModelInputCapabilityBadge /> : null}
      {secondary ? (
        <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-foreground-subtlest">
          {secondary}
        </span>
      ) : null}
    </span>
  );
}

export function ModelPickerSectionLabel({ children }: { children: string }) {
  return (
    <div className="px-2 pt-1.5 pb-0.5 text-ui-xs font-medium text-foreground-subtlest">
      {children}
    </div>
  );
}

interface ModelPickerRowProps {
  item: ModelPickerRowItem;
  providerLabel?: string;
  active: boolean;
  selected: boolean;
  locked: boolean;
  lockReasonMessage: string;
  pin?: ModelPickerPinControl;
  onActivate: () => void;
  onSelect: () => void;
  testId: string;
}

/**
 * 搜索结果 / 快速区的行。刻意不用 Radix Item：Radix Item 悬停会抢走搜索框焦点，
 * 这里由搜索框持有焦点，↑/↓ 只移动 `active`。
 */
export const ModelPickerRow = forwardRef<HTMLDivElement, ModelPickerRowProps>(
  function ModelPickerRow(
    {
      item,
      providerLabel,
      active,
      selected,
      locked,
      lockReasonMessage,
      pin,
      onActivate,
      onSelect,
      testId,
    },
    ref,
  ) {
    return (
      <div
        ref={ref}
        role="menuitemradio"
        aria-checked={selected}
        aria-disabled={locked || undefined}
        tabIndex={-1}
        data-model-picker-row="true"
        data-active={active ? "true" : undefined}
        data-testid={testId}
        data-model-option-selected={selected ? "true" : undefined}
        data-model-option-locked={locked ? "true" : undefined}
        className={cn(
          "group/model-row relative flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1 text-ui-base text-foreground outline-hidden select-none",
          active && "bg-menu-hover",
          locked && "cursor-not-allowed text-foreground-subtlest",
        )}
        onPointerMove={(event: PointerEvent) => {
          if (event.pointerType === "mouse" && !active) onActivate();
        }}
        onClick={() => {
          if (!locked) onSelect();
        }}
      >
        <ModelPickerRowLabel item={item} providerLabel={providerLabel} />
        {pin ? <ModelPickerStarButton {...pin} /> : null}
        {locked ? (
          <span title={lockReasonMessage} className="inline-flex size-4 shrink-0 items-center">
            <AlertCircle className="size-4" aria-hidden="true" />
          </span>
        ) : null}
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          {selected ? <CheckIcon className="size-4 text-foreground-subtle" /> : null}
        </span>
      </div>
    );
  },
);

export const ModelPickerSearchInput = forwardRef<
  HTMLInputElement,
  {
    value: string;
    placeholder: string;
    onChange: (value: string) => void;
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  }
>(function ModelPickerSearchInput({ value, placeholder, onChange, onKeyDown }, ref) {
  return (
    <div className="sticky top-0 z-10 -mx-1 -mt-1 mb-0.5 flex h-8 items-center gap-1.5 border-b border-border bg-menu px-3">
      <SearchIcon className="size-3.5 shrink-0 text-foreground-subtlest" aria-hidden="true" />
      <input
        ref={ref}
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        data-testid="chat-model-select-search"
        className="h-7 min-w-0 flex-1 bg-transparent text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
});
