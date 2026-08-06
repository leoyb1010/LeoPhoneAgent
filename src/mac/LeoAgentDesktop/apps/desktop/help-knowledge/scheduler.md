---
id: scheduler
title: Scheduling automated tasks
summary: Run a prompt automatically on a schedule (recurring or one-off) against a chosen working directory.
---
The Scheduler runs prompts for you on a schedule — recurring (cron-style) or one-off (a specific time).

**Creating a task:**

- Open the Scheduler.
- Give the task a **prompt** (what the agent should do), a **working directory** (where it runs), and a **schedule** — recurring (interval / cron) or one-time (specific datetime).
- Pick which **agent** runs it (Claude Code or Codex) and the model / mode you want.
- Save. The task fires according to its schedule.

**Managing existing tasks:**

- Edit (prompt, schedule, working directory).
- **Pause / resume** without losing the task definition.
- Delete.

**Run history:**

- Each task tracks its past runs — when it fired, whether it succeeded, the resulting session (you can open it to see what the agent did).

**Notes:**

- The task only fires while the desktop app is running on your machine — it's a local scheduler, not a cloud cron. Closing the app means tasks won't fire until you reopen it.
- Tasks run as normal sessions under the hood; you can find their resulting sessions in the sidebar (often grouped by the scheduler).
- If you have two instances open on the same account (e.g. dev + release), they coordinate so a due task fires only once — you won't get duplicate runs.
- A failing task shows the failure in run history but doesn't auto-pause itself — you may want to disable a chronically failing task manually.
