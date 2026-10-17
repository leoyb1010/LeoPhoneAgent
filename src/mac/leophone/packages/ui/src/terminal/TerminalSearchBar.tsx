import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";

import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";

import { getTerminalEnhancements, terminalSearchOptions } from "./terminalEnhancements.js";

/**
 * [leo] 终端 ⌘F 搜索浮条(WP-24):↩ 下一个、⇧↩ 上一个、Esc 关闭并把焦点还给终端。
 * 命中全部高亮(品牌色叠在终端背景上),当前命中更深一档,滚动条旁的标尺同步标出。
 */
export function TerminalSearchBar({ term, onClose }: { term: XTerm | null; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(() =>
    term?.hasSelection() ? (term.getSelection().split("\n")[0] ?? "") : "",
  );
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);
  const search = getTerminalEnhancements(term)?.search ?? null;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (!search) return;
    const subscription = search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultIndex, count: resultCount }),
    );
    return () => {
      subscription.dispose();
      search.clearDecorations();
    };
  }, [search]);

  useEffect(() => {
    if (!search || !term) return;
    if (!query) {
      search.clearDecorations();
      setResults(null);
      return;
    }
    // 输入时增量查找:光标停在当前命中上,不会每敲一个字跳到下一处。
    search.findNext(query, { ...terminalSearchOptions(term), incremental: true });
  }, [query, search, term]);

  const step = (direction: "next" | "previous") => {
    if (!search || !term || !query) return;
    const options = terminalSearchOptions(term);
    if (direction === "next") search.findNext(query, options);
    else search.findPrevious(query, options);
  };

  const close = () => {
    search?.clearDecorations();
    onClose();
    term?.focus();
  };

  const label =
    !query || !results
      ? ""
      : results.count === 0
        ? "无结果"
        : `${results.index + 1}/${results.count}`;

  return (
    <div
      role="search"
      aria-label="在终端中查找"
      className="absolute top-2 right-3 z-10 flex items-center gap-1 rounded-lg border border-border bg-popover px-2 py-1 shadow-md animate-in fade-in slide-in-from-top-2 duration-200 motion-reduce:animate-none"
      onKeyDown={(event) => {
        // 浮条里的按键不能漏给终端(否则 ⌘F 再按、方向键都会进 PTY)。
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          step(event.shiftKey ? "previous" : "next");
        }
      }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="查找"
        aria-label="查找内容"
        spellCheck={false}
        className="h-6 w-44 bg-transparent text-ui-sm text-foreground outline-none placeholder:text-foreground-subtlest"
      />
      <span
        className={cn(
          "min-w-10 text-right text-ui-sm tabular-nums",
          results?.count === 0 ? "text-destructive" : "text-foreground-subtle",
        )}
        aria-live="polite"
      >
        {label}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="上一个"
        onClick={() => step("previous")}
      >
        <ChevronUp className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="下一个"
        onClick={() => step("next")}
      >
        <ChevronDown className="size-3.5" />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭查找" onClick={close}>
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
