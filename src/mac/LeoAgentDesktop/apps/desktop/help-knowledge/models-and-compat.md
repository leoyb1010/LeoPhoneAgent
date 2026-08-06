---
id: models-and-compat
title: Choosing a model
summary: Pick a session's model from the composer dropdown; non-Anthropic models work automatically (no compat toggle to flip).
tab: providers
---
You pick the model a session uses from the **model dropdown in the composer toolbar**. In the dropdown, models are organized under the source providers you've connected. The brand groups they belong to are **Anthropic**, **OpenAI**, **Budget GPT**, **xAI**, **Google**, and **Domestic** (Kimi / GLM / Qwen / DeepSeek), plus non-chat model kinds (image / audio / video / …).

The default depends on the agent: Claude Code defaults to **Opus 4.8**, Codex defaults to a **GPT** model.

**Switching mid-session:**

- Open the dropdown and pick a different model. It takes effect on the **next turn**.

**Using non-Anthropic models:**

- You don't need to flip anything. Claude Code's SDK emits Anthropic-specific request fields (`thinking`, `cache_control`, etc.) that non-Anthropic backends would reject, so the app **always** routes requests through a local proxy that scrubs those fields per-model before forwarding. Claude / Anthropic models pass through untouched.
- (This used to be a manual "Compat Mode" toggle in Settings. That toggle has been retired — the handling is now automatic and always on, so there's nothing to configure.)

**Notes:**

- Which models you can pick depends on the providers connected in **Settings > Model Providers** (see the Providers topic).
- "Budget GPT" is a lower-cost routing tier for GPT models; "Domestic" groups the China-hosted models.
