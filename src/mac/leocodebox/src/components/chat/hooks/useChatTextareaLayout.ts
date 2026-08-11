import { useCallback, useEffect, useRef, useState } from 'react';

interface UseChatTextareaLayoutArgs {
  input: string;
  onInputFocusChange?: (focused: boolean) => void;
}

export function useChatTextareaLayout({ input, onInputFocusChange }: UseChatTextareaLayoutArgs) {
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) return;
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    target.style.height = 'auto';
    const nextHeight = Math.max(22, target.scrollHeight);
    target.style.height = `${nextHeight}px`;

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
  }, []);

  const collapseTextarea = useCallback((focus = false) => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      if (focus) textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, []);

  useEffect(() => {
    if (!textareaRef.current || lastAutosizedInputRef.current === input) return;
    // User typing is resized by onInput; this covers restored/programmatic drafts.
    resizeTextarea(textareaRef.current);
  }, [input, resizeTextarea]);

  useEffect(() => {
    if (!input.trim()) collapseTextarea();
  }, [collapseTextarea, input]);

  const handleInputFocusChange = useCallback((focused: boolean) => {
    setIsInputFocused(focused);
    onInputFocusChange?.(focused);
  }, [onInputFocusChange]);

  return {
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    isInputFocused,
    resizeTextarea,
    collapseTextarea,
    syncInputOverlayScroll,
    handleInputFocusChange,
  };
}
