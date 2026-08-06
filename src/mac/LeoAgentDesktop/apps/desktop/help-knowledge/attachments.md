---
id: attachments
title: Attaching files and images, and referencing code
summary: Paste / drag images, @-mention files, and add extra reference directories from the composer.
---
You can give the agent more than plain text.

**Images:**

- **Paste** an image from the clipboard, or **drag** image files onto the composer.
- Accepted formats: **PNG, JPEG, WEBP, and GIF**.
- Thumbnails appear above the input; click one to open a full-screen lightbox preview (remove from there, or ESC to close).

**`@`-mention to reference files / directories / agents:**

- Type `@` to open the picker. It shows files, directories, and registered agents in one flat list.
- Scope: the picker scans your session's **working directory** (extra reference directories are given to the agent as context but aren't part of the `@` picker's file scan).
- Matching is fuzzy, with a boost for prefix matches on the filename.

**Extra reference directories (read-only context for the agent):**

- Open the composer's **+** menu (to the left of the permission selector — it also hosts New Goal, Plan Mode, and Plugins) and add a directory from the OS folder dialog.
- Per-session; up to **10** extra directories. This section shows for **Claude Code** sessions (Codex ignores extra directories).
- Directories that are subdirectories of the current working directory are silently skipped (already covered). Parent / ancestor directories are flagged with a warning.
- The agent gets read-only context for these directories — it can grep / read them, but writes still go to the working directory.

**Notes:**

- Image attachments are sent with that user message only; they're not implicitly re-included on subsequent turns.
- The `@`-mention just inserts a reference string into your prompt — it's the agent's job to actually open / read the referenced item.
