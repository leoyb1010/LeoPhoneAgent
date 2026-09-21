// [leo] 关于窗口的图标:LeoPhoneAgent 标志(packages/ui/src/assets/leo-logo.svg 的 base64)。
const LEO_ABOUT_LOGO_BASE64 = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDI0IiBoZWlnaHQ9IjEwMjQiIHZpZXdCb3g9IjAgMCAxMDI0IDEwMjQiIHJvbGU9ImltZyIgYXJpYS1sYWJlbD0ibGVvY29kZWJveCI+CiAgPGRlZnM+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImJnIiB4MT0iMTY4IiB5MT0iOTYiIHgyPSI4NTYiIHkyPSI5MjgiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjMTAxODIwIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMC41NCIgc3RvcC1jb2xvcj0iIzE3MjYyQiIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMwRDExMTciLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9Im1hcmsiIHgxPSIyODgiIHkxPSIyMjQiIHgyPSI3NjAiIHkyPSI4MDAiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjRUFGN0YyIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMC41MiIgc3RvcC1jb2xvcj0iIzU2RjBCOCIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMyRkE3RkYiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImVkZ2UiIHgxPSIyMTYiIHkxPSIxNTIiIHgyPSI4MDgiIHkyPSI4NzIiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjNUVGMEM0IiBzdG9wLW9wYWNpdHk9IjAuOTIiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMkZBN0ZGIiBzdG9wLW9wYWNpdHk9IjAuODgiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8ZmlsdGVyIGlkPSJzb2Z0U2hhZG93IiB4PSIxMDgiIHk9IjEwOCIgd2lkdGg9IjgwOCIgaGVpZ2h0PSI4MDgiIGNvbG9yLWludGVycG9sYXRpb24tZmlsdGVycz0ic1JHQiIgZmlsdGVyVW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KICAgICAgPGZlRHJvcFNoYWRvdyBkeD0iMCIgZHk9IjI4IiBzdGREZXZpYXRpb249IjM4IiBmbG9vZC1jb2xvcj0iIzAwMDAwMCIgZmxvb2Qtb3BhY2l0eT0iMC4zNiIvPgogICAgICA8ZmVEcm9wU2hhZG93IGR4PSIwIiBkeT0iMCIgc3RkRGV2aWF0aW9uPSIxOCIgZmxvb2QtY29sb3I9IiM1NkYwQjgiIGZsb29kLW9wYWNpdHk9IjAuMTQiLz4KICAgIDwvZmlsdGVyPgogIDwvZGVmcz4KICA8cmVjdCB3aWR0aD0iMTAyNCIgaGVpZ2h0PSIxMDI0IiByeD0iMjI2IiBmaWxsPSJ1cmwoI2JnKSIvPgogIDxwYXRoIGQ9Ik0yNDYgMjM4SDc3OEM4MDIuMzAxIDIzOCA4MjIgMjU3LjY5OSA4MjIgMjgyVjc0MkM4MjIgNzY2LjMwMSA4MDIuMzAxIDc4NiA3NzggNzg2SDI0NkMyMjEuNjk5IDc4NiAyMDIgNzY2LjMwMSAyMDIgNzQyVjI4MkMyMDIgMjU3LjY5OSAyMjEuNjk5IDIzOCAyNDYgMjM4WiIgZmlsbD0iIzBCMEYxNCIgb3BhY2l0eT0iMC43NCIvPgogIDxwYXRoIGQ9Ik0yNDYgMjM4SDc3OEM4MDIuMzAxIDIzOCA4MjIgMjU3LjY5OSA4MjIgMjgyVjc0MkM4MjIgNzY2LjMwMSA4MDIuMzAxIDc4NiA3NzggNzg2SDI0NkMyMjEuNjk5IDc4NiAyMDIgNzY2LjMwMSAyMDIgNzQyVjI4MkMyMDIgMjU3LjY5OSAyMjEuNjk5IDIzOCAyNDYgMjM4WiIgc3Ryb2tlPSJ1cmwoI2VkZ2UpIiBzdHJva2Utd2lkdGg9IjI4IiBvcGFjaXR5PSIwLjc4Ii8+CiAgPGcgZmlsdGVyPSJ1cmwoI3NvZnRTaGFkb3cpIj4KICAgIDxwYXRoIGQ9Ik0zMTQgMzE0SDQzNlY2MTJINjUwVjcxMEgzMTRWMzE0WiIgZmlsbD0idXJsKCNtYXJrKSIvPgogICAgPHBhdGggZD0iTTU2MiA0MjBMNzEwIDUxMkw1NjIgNjA0VjUxNEw2NDAgNTEyTDU2MiA1MTBWNDIwWiIgZmlsbD0iI0VBRjdGMiIvPgogICAgPGNpcmNsZSBjeD0iNzEwIiBjeT0iNTEyIiByPSI0MyIgZmlsbD0iIzU2RjBCOCIvPgogIDwvZz4KICA8cGF0aCBkPSJNMzA4IDI0Mkg3MTYiIHN0cm9rZT0iI0ZGRkZGRiIgc3Ryb2tlLW9wYWNpdHk9IjAuMTYiIHN0cm9rZS13aWR0aD0iMTIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K";

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
