// [leo] 关于窗口的图标:LeoBot 机器人标志(packages/ui/src/assets/leo-logo.svg 的 base64,改 SVG 时同步重新生成)。
const LEO_ABOUT_LOGO_BASE64 = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDI0IiBoZWlnaHQ9IjEwMjQiIHZpZXdCb3g9IjEwMCAxMDAgODI0IDgyNCIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsPSJMZW9Cb3QiPgogIDxyZWN0IHg9IjEwMCIgeT0iMTAwIiB3aWR0aD0iODI0IiBoZWlnaHQ9IjgyNCIgcng9IjE5MCIgZmlsbD0iI0Y4RjZFRSIvPgogIDxwYXRoIGQ9Ik0zNDUgNDc1QzM0NSAzNzAgNDIwIDMxMiA1MzAgMzEySDc2MEM4NzAgMzEyIDk0MCA0MDAgOTQwIDUwMEM5NDAgNTcwIDkwNSA2MjAgODYwIDY0NUM5MTUgNjcwIDk0OCA3MjUgOTQ4IDc5MEM5NDggODgwIDg4MCA5NDIgNzkwIDk0Mkg1MjBDNDIwIDk0MiAzNDUgODgwIDM0NSA3OTBaIiBmaWxsPSIjOUJCOEQzIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSg1MTIgNTEyKSBzY2FsZSgwLjYyKSB0cmFuc2xhdGUoLTYyMiAtNjI3KSIvPgogIDxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDUxMiA1MTIpIHNjYWxlKDAuNjIpIHRyYW5zbGF0ZSgtNjIyIC02MjcpIj4KICAgIDxyZWN0IHg9IjMzMCIgeT0iNDc1IiB3aWR0aD0iOTUiIGhlaWdodD0iMTg3IiByeD0iNDciIGZpbGw9IiMzQTVBODAiLz4KICAgIDxyZWN0IHg9IjI5OCIgeT0iNDc1IiB3aWR0aD0iNzUiIGhlaWdodD0iMTg3IiByeD0iMzciIGZpbGw9IiM5QkI4RDMiLz4KICAgIDxyZWN0IHg9IjUxMiIgeT0iMzk1IiB3aWR0aD0iMzg0IiBoZWlnaHQ9IjIzNyIgcng9IjEwNSIgZmlsbD0iIzFEMzM0OSIvPgogICAgPHBhdGggZD0iTTU3NSA1MzhRNjE3IDQ4MiA2NTkgNTM4TTc2MCA1MzhRODAyIDQ4MiA4NDQgNTM4IiBmaWxsPSJub25lIiBzdHJva2U9IiNGQkY2RUEiIHN0cm9rZS13aWR0aD0iMjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgogICAgPHJlY3QgeD0iNjM0IiB5PSI3NjAiIHdpZHRoPSIxNDYiIGhlaWdodD0iNDIiIHJ4PSIyMSIgZmlsbD0iIzFEMzM0OSIvPgogIDwvZz4KPC9zdmc+Cg==";

interface CustomAboutDialogHtmlInput {
  applicationName: string;
  appVersion: string;
  copyright: string;
  optimizationLine: string;
  versionLabel: string;
  okButtonLabel: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createCustomAboutDialogHtml(input: CustomAboutDialogHtmlInput): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    />
    <title>${escapeHtml(input.applicationName)}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        --startup-page-bg: #f4f4f5;
        --about-primary: #0a0a0a;
        --about-primary-foreground: #fafafa;
        --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: var(--startup-page-bg);
      }

      body {
        display: grid;
        place-items: center;
        padding: 0;
        user-select: none;
      }

      .about-window {
        width: 100%;
        max-width: 256px;
        height: 280px;
        display: grid;
        place-items: stretch;
        padding: 0;
        background: transparent;
      }

      .about-card {
        width: 100%;
        height: 100%;
        padding: 22px 15px 14px;
        display: flex;
        flex-direction: column;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: #1d1d1f;
        box-shadow: none;
        -webkit-app-region: drag;
      }

      .content {
        width: 100%;
        max-width: 222px;
        margin: 0 auto;
        flex: 1;
        min-height: 0;
      }

      .app-icon {
        width: 52px;
        height: 52px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 12px;
        color: #ffffff;
        box-shadow: 0 10px 13px -3px rgb(0 0 0 / 0.2), 0 4px 5px -3px rgb(0 0 0 / 0.2);
      }

      .app-logo {
        width: 52px;
        height: 52px;
        display: block;
        border-radius: 12px;
      }

      .title {
        margin: 20px 0 0;
        font-size: 13.5px;
        line-height: 1.18;
        font-weight: 700;
        letter-spacing: 0;
      }

      .meta {
        margin-top: 28px;
        display: flex;
        flex-direction: column;
        gap: 17px;
        font-size: 13px;
        line-height: 1.2;
        font-weight: 400;
        letter-spacing: 0;
        color: #303033;
      }


      .ok-button {
        width: 100%;
        height: 36px;
        border: 0;
        border-radius: 18px;
        background: var(--about-primary);
        color: var(--about-primary-foreground);
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0;
        outline: none;
        cursor: default;
        -webkit-app-region: no-drag;
      }

      .ok-button:active {
        background: var(--about-primary-active);
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --startup-page-bg: #171717;
          --about-primary: #fafafa;
          --about-primary-foreground: #0a0a0a;
          --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
        }

        .about-card {
          color: #e8e8e8;
        }

        .meta {
          color: #e2e2e2;
        }
      }
    </style>
  </head>
  <body>
    <main class="about-window" aria-label="${escapeHtml(input.applicationName)} About Window">
      <section class="about-card" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <div class="content">
          <div class="app-icon" aria-hidden="true">
            <img class="app-logo" src="data:image/svg+xml;base64,${LEO_ABOUT_LOGO_BASE64}" alt="" />
          </div>
          <h1 id="about-title" class="title">
            ${escapeHtml(input.applicationName)}<br />
            ${escapeHtml(input.versionLabel)} ${escapeHtml(input.appVersion)}
          </h1>
          <div class="meta">
            ${input.optimizationLine ? `<div>${escapeHtml(input.optimizationLine)}</div>` : ""}
            <div>${escapeHtml(input.copyright)}</div>
          </div>
        </div>
        <div class="spacer"></div>
        <button class="ok-button" type="button" autofocus>${escapeHtml(input.okButtonLabel)}</button>
      </section>
    </main>
    <script>
      const closeWindow = () => window.close();
      document.querySelector(".ok-button")?.addEventListener("click", closeWindow);
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" || event.key === "Enter") {
          closeWindow();
        }
      });
    </script>
  </body>
</html>`;
}
