import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

function renderMarkdown(markdown: string, locale: "zh-CN" | "en-US" = "zh-CN"): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        ZCodeIntlProvider,
        { initialLocale: locale },
        createElement(MessageResponse, null, markdown),
      ),
    ),
  );
}

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("[leo] markdown data: images", () => {
  it("位图 base64 data URL 进入 MarkdownImage", () => {
    const html = renderMarkdown(`![dot](${PNG_DATA_URL})`);
    expect(html).toContain("data-markdown-image");
    expect(html).toContain(`src="${PNG_DATA_URL}"`);
  });

  it.each([
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "data:image/svg+xml;base64,PHN2Zy8+",
  ])("非位图 data URL 被剥掉：%s", (src) => {
    const html = renderMarkdown(`![x](${src})`);
    expect(html).not.toContain("data:");
  });

  it("https 图片不受影响", () => {
    expect(renderMarkdown("![x](https://example.com/a.png)")).toContain(
      'src="https://example.com/a.png"',
    );
  });
});

describe("[leo] GitHub callouts", () => {
  it("剥离标记并渲染本地化标题", () => {
    const html = renderMarkdown("> [!WARNING]\n> 小心磁盘空间");
    expect(html).toContain('data-markdown-callout="warning"');
    expect(html).toContain("警告");
    expect(html).toContain("小心磁盘空间");
    expect(html).not.toContain("[!WARNING]");
  });

  it("大小写不敏感，英文标题", () => {
    const html = renderMarkdown("> [!tip]\n> Use pnpm", "en-US");
    expect(html).toContain('data-markdown-callout="tip"');
    expect(html).toContain("Tip");
    expect(html).not.toContain("[!tip]");
  });

  it("普通引用与流式半截标记按原样渲染", () => {
    expect(renderMarkdown("> just a quote")).not.toContain("data-markdown-callout");
    const partial = renderMarkdown("> [!NOT");
    expect(partial).not.toContain("data-markdown-callout");
    expect(partial).toContain("data-markdown-blockquote");
  });

  it("只有标记没有正文时不留空段落", () => {
    const html = renderMarkdown("> [!NOTE]");
    expect(html).toContain('data-markdown-callout="note"');
    expect(html).toContain("注意");
    expect(html).not.toContain("<p></p>");
  });
});
