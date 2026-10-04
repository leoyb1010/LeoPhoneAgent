# Round 1: Home and chat admission contract

Scope: the Home composer, selected model before first send, and queued attachments.
This is an implementation contract, not a full-product or visual acceptance claim.

- Home has separate execution-location and model controls. The model control is at
  least 44 pt high and opens the model sheet directly; Mac target/CLI selection
  remains in the execution menu. Reset-to-default applies only to the next chat.
- An available direct model can start a chat without any model groups. A stale or
  unavailable explicit choice retains the prompt and reports failure. It must not
  silently bind a default, previous, or different provider/model.
- Before the first session is persisted, image capability checks resolve the Home
  entry/group. Resolver cache identity includes the initial choice and draft id.
  Explicit load-balanced groups keep the draft routing id through initial binding.
- Home text and model choice restore from a separate protected app-support JSON
  file. Typing saves after a short debounce; background/disappearance flushes the
  final edit. Consumed text/choice clears the saved draft. Search stays transient;
  the existing in-chat new-draft file is unchanged. An untouched window does not
  overwrite a newer saved draft during a lifecycle flush.
- Send and enqueue do not consume a composer containing loading attachments.
  Queue snapshots include ready attachments only. Failed-only attachments cannot
  create an empty queued turn; ready siblings remain queueable after loading ends.

## Focused verification

Run independently; all use temporary files and synthetic adapters, with no
simulator, credentials, network, or user's provider/chat data:

```sh
python3 scripts/IOSComposerQueueSmoke.py
python3 scripts/IOSDraftModelSmoke.py
python3 scripts/IOSHomePromptSmoke.py
python3 scripts/IOSHomeDraftSmoke.py
```

These execute the actual production methods/predicates or HomeDraft class. Queue,
Home routing, and draft resolution reproduced behavioral failures before fixes.
Home persistence initially failed compilation because the persistence API did not
exist, then executes storage/reconstruction/debounce/clear/isolation assertions.
Provider availability, group routing and database dependencies are in-memory
adapters; the tests do not prove actual authentication, SQLite integration or UI.
Swift parser checks establish syntax only.

Required real-render follow-up: small iPhone + iPad/large Dynamic Type model entry
reachability, duplicate-provider names, text-only default → vision Home choice →
camera first send, delayed photo load while streaming, Home background/relaunch,
and changing/deleting the selected provider before sending. Preserve the immutable
installed baseline until its screenshots have been captured.
