# Full renderer audit journeys

The driver uses new synthetic HOME/workspace directories and the application's actual UI. They never enter a real API key or submit a provider prompt.

- `run-desktop.mjs`: hosted macOS only, installed pinned Electron, unpackaged production build, actual main/Local Host/WindowController. It asserts isolated home/userData/sessionData, enabled Chromium sandbox, and no development update switch.
- `seed-task.ts`: creates one synthetic failed/unread task via production persistence. `--desktop` also writes the synthetic workspace/locale through the production settings service; `--read` is read-only. Opening a task must clear unread without changing the failed outcome or duplicating the task.

Screenshot, text, accessibility tree and process evidence are saved. Browser-context route filtering blocks later renderer requests to external origins. This does not establish zero external requests from every process, before route installation, or over WebSocket. No native account authentication, physical device, signed distribution or installation is represented by these tests.

The first native task-open attempt exposed an incomplete synthetic seed: a legacy JSON backup is not the current CLI's persisted V4 session. A current-format seed must create session/message/part records through SqliteSessionStore, using the same project identity and isolated default database path as the runtime. This changes test input construction only; history/read assertions stay strict and no production session storage is changed.
