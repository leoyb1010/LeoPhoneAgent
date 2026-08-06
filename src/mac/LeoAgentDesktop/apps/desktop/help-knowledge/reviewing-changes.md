---
id: reviewing-changes
title: Reviewing the agent's file changes
summary: Open the Review tab in the right sidebar to see what changed as git-style diffs, and stage / revert hunks.
---
When you want to see what the agent changed, use the **Review** tab in the right sidebar — it shows the working directory's changes as git diffs.

**Opening it:**

- In the right sidebar, open the **+** menu and pick **Review** to add the Review tab.
- The diffs come from a real **git diff** of your working directory against a base ref — not from replaying the agent's individual Edit / Write calls. You can change the base branch it compares against.

**Inside the tab:**

- Changed files are shown as diffs, **expanded by default**; collapse the ones you don't care about.
- Toggle between **unified** and **split** views. There's also inline word-diff, word-wrap, hide-whitespace, a file tree, and a rich Markdown preview for `.md` files.
- Colors follow git convention: **red removed / green added**.

**Acting on changes:**

- Each hunk has action pills to **stage / unstage / revert** it — so you can review the agent's edits and selectively keep or roll back individual hunks right from the tab.

**Notes:**

- Because the tab reflects real git state, it shows everything in your working tree — including edits you made yourself — not only what the agent touched this turn.
- This is separate from **Plan mode** (approving a plan before work starts) and from the **collaboration** worker panes.
