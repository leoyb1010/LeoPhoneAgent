import { forwardRef, useState, type InputHTMLAttributes } from "react";

/** Localized browser chrome only; File objects, names and callbacks stay untouched. */
export const ChineseFileInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function ChineseFileInput({ className, onChange, disabled, "aria-label": ariaLabel, ...props }, ref) {
    const [names, setNames] = useState<string[]>([]);
    return (
      <label className={`relative flex min-w-0 items-center gap-3 rounded-md border border-border px-2.5 py-1.5 text-sm focus-within:ring-2 focus-within:ring-ring ${disabled ? "opacity-50" : "cursor-pointer"} ${className ?? ""}`}>
        <span className="shrink-0 rounded-md bg-muted px-2.5 py-1 text-xs">选择文件</span>
        <span className="truncate text-muted-foreground" aria-live="polite">{names.length ? names.join("、") : "未选择文件"}</span>
        <input {...props} ref={ref} type="file" disabled={disabled} aria-label={ariaLabel ?? "选择文件"}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          onChange={(event) => {
            onChange?.(event);
            // Read after the callback so the upstream clear-for-reselect behavior remains visible.
            setNames(Array.from(event.currentTarget.files ?? []).map(file => file.name));
          }} />
      </label>
    );
  },
);
