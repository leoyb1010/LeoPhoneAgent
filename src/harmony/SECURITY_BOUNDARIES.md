# Mobile audit corrections (2026-09-30)

## Harmony behavior contract

- External conversation archives cannot carry local image paths. PNG/JPEG bytes are limited to 8 MiB and 24 million pixels per image, with a 32 MiB import-text limit, then written under newly generated local attachment names. Existing internal attachment references are read/deleted only when both root and file are non-symlinks under `chat-images`. Duplicated sessions retain their shared attachments until the final reference is removed.
- Unattended remote/scheduled runs keep the same capability restrictions for quick text actions and model tools. Weather with an explicit city remains available; current-location weather requires the location capability. Foreground interactive behavior and explicitly enabled full-auto remain available.
- Remote turns use the same summary/resume/attachment-aware bounded conversation history builder as local chat, including the newly appended user message exactly once.
- A schedule slot is claimed durably before any task effect. A failed/crashed/uncertain attempt is not automatically replayed that day. The next day's normal slot remains eligible. A user can inspect the conversation and explicitly continue/retry there. This is at-most-once automatic admission, not a claim that external effects are transactional or exactly once.
- Provider, MCP, environment-name and schedule metadata use fully written, fsynced temporary files and atomic replacement. Independent temporary names prevent collision; an OS-locked sidecar plus each store's observed bytes rejects stale concurrent configuration writes. The user must reload after a conflict. Session archives retain atomic replacement and use the same short-write checks.

## Validation scope

`node src/harmony/protocol/security-boundaries.test.mjs` executes actual non-UI ETS source with Node-backed IO and explicitly mocked platform services. It tests malicious attachment paths, symlinks, shared attachment cleanup, payload limits, native capability decisions, history plumbing, crash/restart-equivalent schedule admission, write fault injection and stale-write conflict detection.

It does not substitute for DevEco/Hvigor compilation, native image decoding, native file-lock/filesystem behavior, real system permissions, app lifecycle or device tests. Run `src/harmony/scripts/build_hap.sh` and device checks before a release.


## ROUND1 follow-on corrections

- Provider/MCP/environment metadata now refers to immutable, randomly named encrypted secret generations. Each generation includes its row identity and destination binding. A failed or stale metadata write cannot overwrite the credential referenced by the winning metadata. Old generations are retired only after a confirmed durable metadata commit; generations staged by failed or uncertain operations are retained for recovery rather than guessed safe to delete.
- Provider OAuth access and refresh credentials follow the same generation. Binding a login verifies the expected access credential; stale refresh cannot update a replacement generation. API-key fallback never consumes another generation's secret.
- Rename followed by directory open/fsync/close failure is explicitly reported as uncertain durability. The writer reads back its visible generation under the existing lock. Actual stores restore their metadata+secret cache and keep reporting the original failure. MCP and environment settings pages use public reload APIs, which serialize with writes.
- Existing fixed-alias records are migrated to generation references while preserving their original destination/credential pair. Do not downgrade to a build that does not understand generation references, particularly while resolving an uncertain commit. Orphan generation garbage collection is deliberately not inferred from a failed write.
- Protocol fixtures use local wall-clock construction for local-time scheduling behavior. The protocol, actual-source security suite and release-note checks are exercised under UTC, Asia/Shanghai and America/Los_Angeles.

`node src/harmony/protocol/configuration-generations.test.mjs` executes actual ProviderStore, McpStore and EnvStore mutations, SecretStore-adapted generation handling, stale writers/removals and pre/post-rename failures. It is also imported by the existing security-boundaries suite. Platform adapters remain mocked; this is not native ArkTS or device validation.
