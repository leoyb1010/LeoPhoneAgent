"use client";

import {
  InfoIcon,
  LightbulbIcon,
  MessageSquareWarningIcon,
  OctagonAlertIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { Children, cloneElement, isValidElement } from "react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export type MarkdownBlockquoteProps = ComponentProps<"blockquote"> & {
  node?: unknown;
};

// [leo] GitHub callout：`> [!NOTE]` 等。色调复用全局语义 token，四套主题都有亮/暗定义。
const calloutStyles = {
  note: {
    icon: InfoIcon,
    box: "border-interaction-ask-foreground bg-interaction-ask-surface",
    title: "text-interaction-ask-foreground",
  },
  tip: { icon: LightbulbIcon, box: "border-success bg-success/10", title: "text-success" },
  important: {
    icon: MessageSquareWarningIcon,
    box: "border-primary/35 bg-primary/5",
    title: "text-primary",
  },
  warning: { icon: TriangleAlertIcon, box: "border-warning bg-warning/10", title: "text-warning" },
  caution: {
    icon: OctagonAlertIcon,
    box: "border-destructive bg-destructive/10",
    title: "text-destructive",
  },
} satisfies Record<string, { icon: LucideIcon; box: string; title: string }>;

type CalloutKind = keyof typeof calloutStyles;

const calloutMarkerPattern = /^\s*\[!(note|tip|important|warning|caution)\][^\S\n]*\n?/i;

/** 识别首段开头的 callout 标记并剥离；流式中的半截标记不匹配，按普通引用渲染。 */
export function splitMarkdownCallout(
  children: ReactNode,
): { kind: CalloutKind; children: ReactNode[] } | null {
  const items = Children.toArray(children);
  const index = items.findIndex((child) => typeof child !== "string" || child.trim() !== "");
  const paragraph = items[index];
  if (!isValidElement(paragraph)) return null;
  const element = paragraph as ReactElement<{ children?: ReactNode; node?: { tagName?: string } }>;
  if (element.props.node?.tagName !== "p") return null;

  const [first, ...rest] = Children.toArray(element.props.children);
  const match = typeof first === "string" ? first.match(calloutMarkerPattern) : null;
  if (!match || typeof first !== "string") return null;

  const remainder = [first.slice(match[0].length), ...rest].filter((child) => child !== "");
  const hasContent = remainder.some((child) => typeof child !== "string" || child.trim() !== "");
  const next = [...items];
  if (hasContent) next[index] = cloneElement(element, undefined, ...remainder);
  else next.splice(index, 1);
  return { kind: match[1]!.toLowerCase() as CalloutKind, children: next };
}

export function MarkdownBlockquote({
  children,
  className,
  node: _node,
  ...props
}: MarkdownBlockquoteProps) {
  const { intl } = useZCodeIntl();
  const callout = splitMarkdownCallout(children);

  if (callout) {
    const style = calloutStyles[callout.kind];
    const Icon = style.icon;
    return (
      <blockquote
        className={cn(
          "my-4 rounded-r-md border-l-2 px-3 py-2 text-foreground",
          "[&_p]:my-0 [&_p+p]:mt-2",
          style.box,
          className,
        )}
        data-markdown-blockquote=""
        data-markdown-callout={callout.kind}
        {...props}
      >
        <div className={cn("mb-1 flex items-center gap-1.5 font-medium", style.title)}>
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          {intl.formatMessage({ id: `markdown.callout.${callout.kind}` })}
        </div>
        {callout.children}
      </blockquote>
    );
  }

  return (
    <blockquote
      className={cn(
        "my-4 border-border border-l-2 pl-3 text-foreground-subtle",
        "[&_p]:my-0 [&_p+p]:mt-2",
        className,
      )}
      data-markdown-blockquote=""
      {...props}
    >
      {children}
    </blockquote>
  );
}
