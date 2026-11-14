---
name: html-workbench
description: Build and refine real HTML pages, interactive reports, prototypes and small web tools. Use for requests to make HTML, webpages, interactive reports, browser demos or to improve an existing page. Deliver runnable files, verify the user's main journey, and retain the project's existing stack and design system.
---

# HTML workbench

Use the current workspace and its AGENTS.md. Understand the user's goal, content, required interaction and output format. For an existing project, extend its actual stack. For a standalone deliverable, prefer a complete offline HTML file with inline CSS and JavaScript. Do not require the user to install a framework for a small page.

## Build a useful result

- Write real files inside the authorized workspace. Retain existing work and manual edits; inspect the current file before revising it.
- Give one primary action a clear place. Keep the layout, type, spacing, contrast, focus and button states consistent. For LeoBot-owned work use restrained neutral surfaces and blue; supplied project branding takes precedence.
- Use realistic supplied content, clear Chinese or the user's language, and functional controls. Do not invent business data, live metrics, sources or a claim of completed work.
- Make narrow windows usable. Keep inputs and their feedback together, prevent accidental full-page horizontal overflow, and honor reduced motion.
- Implement the entire requested interaction: input, action, feedback, result, failure or boundary, then reset/retry when appropriate. A visual button without behavior is incomplete.
- Do not embed production credentials, private tokens, native bridges or unrequested telemetry in HTML. Ask only when a real missing dependency or authorization boundary requires it.

## Verify with the tools actually available

1. Run the project's own type/build/test checks that are relevant to the change. For standalone HTML, check JavaScript syntax and open it in an available real browser.
2. Render at the intended desktop width and a narrow width. Inspect screenshots at readable size; fix the largest hierarchy, wrapping, overlap or clipping issue.
3. Perform the user's main journey, one failure/boundary, keyboard use and reduced motion. Inspect page errors and unexpected requests. Test each important link/button according to its intended outcome.
4. For promised offline output, move only the deliverable to a fresh directory and block network requests; verify it still works without original files or a dev server.
5. Keep the original file and validation evidence attributable to this task. A screenshot path or a successful tool result is evidence; the model saying “verified” is not. If no browser/check can run, explicitly name the missing check and leave its status unverified.

## Deliver and iterate

Return a usable file link with a concise description of the result, checks actually run and material limits. LeoBot can show single-file HTML in an isolated static preview; scripts run only when the user enables interaction for that version. Remote URLs, relative assets and project modules may be blocked there; multi-file applications need their own authorized preview environment.

On a follow-up, read the latest source and preserve manual edits. Modify the requested behavior, rerun affected checks and provide the updated real artifact. Do not replace a user's current draft or silently publish/deploy anything.

HTML, DOCX, PPTX, XLSX and PDF are different formats. Never rename HTML to pretend it is a native document. Use the appropriate available workflow and format validators for those outputs.
