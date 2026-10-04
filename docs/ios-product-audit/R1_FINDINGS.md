# Round 1 — full product audit record

Baseline: main `61ccd292`, installed version 1.50.0 (137). The installed binary's source commit has not been independently established. Device screenshots are baseline evidence, not evidence of the working-tree fixes.

## Confirmed findings and changes

| Journey | Finding | Change and evidence |
| --- | --- | --- |
| Home / models | Device UI combines models and execution machines in a menu that occupies most of the screen. | Separate execution and model controls; native quick picker, favorites, recent entries, global search and management. Actual component tests cover choosing, default isolation and returning from management. Full Home rendering remains pending. |
| Home / chat | Direct selection cannot send without a group; unavailable initial choice can fall back; initial vision capability can resolve against the wrong model. | Preserve explicit draft choice and resolve its capability before send. `IOSHomePromptSmoke.py` and `IOSDraftModelSmoke.py` exercise extracted production methods. |
| Home / drafts | Home input is transient and separate from chat drafts. | Opt-in protected persistence with debounce and lifecycle flush, including chosen model. `IOSHomeDraftSmoke.py` checks restoration, isolation and consumed-draft clearing. |
| Chat / attachments | Queuing a loading attachment captures a placeholder that cannot receive its later result. | UI and method both gate loading; failed attachments excluded. `IOSComposerQueueSmoke.py`. |
| Sessions / search | Literal percent and underscore broaden SQLite LIKE matches. | Escape literal patterns in title and message search. `IOSSessionSearchSmoke.py` reproduces the failure and verifies the production query against SQLite. |
| Files | Same-name import removes an existing destination before copy completes. | Keep both with unique names; preserve the source and existing destination on failure. `IOSSupportRecoveryTests.py`. |
| Environment variables | Duplicate names and persistence failures dismiss the editor; rename can delete the original secret prematurely. | Return typed outcomes, retain drafts, retire the old key after successful persistence. Same-key metadata failure was independently reproduced and repaired, including failed compensation and honest partial-success reporting. |
| MCP | Import silently replaces existing server identities and hides persistence failure. | Preview collisions, confirm replacement, keep JSON and prior configuration on failure. Production-method regression in `IOSSupportRecoveryTests.py`. |
| Remote console | Failed or ambiguous sending loses the composer's text or invites duplicate execution. | Restore definitely unsent content; preserve newer text and explicitly warn on unknown acceptance. `IOSSupportRecoveryTests.py`. |
| Treasury | Failed attachment copy can still publish a successful handoff. | Prepare all copies before publishing; clean only newly created copies and retain original selection on failure. `IOSTreasuryAttachmentTransferSmoke.py`. |
| Skills | File read, decoding and archive-copy errors disappear; staging names collide. | Report failures, retain the import screen, use isolated staging and preserve original files. `IOSSkillFilePickerSmoke.py`. |
| Watch | Settings do not subscribe to pairing/activation changes and can clear a saved unavailable selection on appearance. | Observe explicit connection state events; retain saved choice; offline queued delivery remains allowed. `IOSSettingsStatusSmoke.py`. |
| Remote hosts | Editing a host does not refresh reachability; an old probe can overwrite newer state. | Restart on configuration change and reject stale/cancelled results. `IOSSettingsStatusSmoke.py`. |
| Sync categories | Edits/deletions while a category is disabled are discarded; paused rows may starve legacy enabled work. | Retain local intent, filter before limits, backfill only the enabled category without overwriting tombstones or frozen revisions; recheck at send boundaries. `SyncCategoryPolicyTests.py`, `SyncCategoryNetworkTests.py`. |
| Sync status | Device shows `EnvVarV2: record payload unavailable; retry after restoring source`. Source confirms an intentionally retired singleton builder can still receive new outgoing tasks. | Precisely retire empty canonical legacy singleton upserts at normal startup and prevent their recreation. Keep deletes, real frozen payloads, per-item records, unknown identities and V1 fallback. SQL migration/replica-seeding tests pass. No remote deletion or false delivery acknowledgment. |

## Evidence and limits

- Device control: both wired and Wi-Fi XCTest attempts failed before test execution with the same driver-channel error. Neither result establishes a network or VPN cause. Further repeated attempts stopped. Apple `devicectl device capture screenshot` and DeviceHub provide actual installed-App evidence instead.
- During baseline DeviceHub navigation, a moving sheet caused one accidental change from a conversation's group to its current model. The original group was restored and confirmed visually. No message was sent. Recent-choice bookkeeping may have changed; internal binding identity was not independently read back. The private evidence records this deviation.
- Native model harness runs unchanged production view/model sources with synthetic storage and external-service adapters. It is not the full App, cloud, iSH, audio hardware or WatchConnectivity integration.
- Device navigation, isolated behavior tests, source inspection and unexecuted paths must be reported separately in the external coverage matrix. An opened settings screen does not prove the corresponding operation works.
- All three rounds of source audits are now recorded. Final integrated test and device evidence is summarized in `DELIVERY_20261004.md`; this file preserves the first-round findings and baseline limitations.
