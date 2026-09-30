# Audit hardening delivery notes — 2026-09-30

> This document records source-hardening scope, test evidence and remaining platform boundaries. It is not a release acceptance certificate; use the exact branch commit’s CI results and final review result for its current status.

## Scope

Changes cover approval and SSH boundaries, iOS sync durability and filesystem/archive handling, Mac/relay revocation and WebFetch, Android/Harmony storage/session boundaries, and current-product CI. The original baseline is `6dba575e9e6ed91f33d3a502c66bef317eeb48c3`.

The first independent review blocked its candidate with 11 findings. The second independent review found four additional issues. Both rounds have retained immutable artifacts; final repairs require independent closure checks before publication. Executable regressions cover each confirmed finding. Native checks listed below are separate gates.

## Original finding disposition

`Mitigated` means a source correction and feasible regression evidence exist, but required native/integration verification or an explicit boundary remains. `Fixed` is limited to the documented tested surface; it is not a whole-system security guarantee.

| Finding | Disposition | Implementation and remaining boundary |
| --- | --- | --- |
| CORE-01 | Mitigated | Strict execution-bound auto-approval with actual Git fsmonitor/clean-filter controls; Git worktree/content inspection requires normal approval and only three exact metadata-only rev-parse forms remain automatic; native app approval UI and device execution remain unrun. |
| CORE-02 | Mitigated | Explicit endpoint-bound public-key pinning for direct/gateway; exact Citadel validator compiled and tested; native iOS settings/real SSH handshake still needed. |
| ENG-01 | Mitigated | Current Mac/relay/Harmony source gates added and Android removed tools-package failure corrected. Post-push exact-SHA CI pending; branch protection and native release/device gates unchanged. |
| ENG-02 | Fixed | Corrected README/build target/version paths and added manifest-derived entry-point regression check. |
| ENG-03 | Deferred | Structural size/legacy coexistence is not a single correctness bug; broad refactor intentionally excluded until state contracts and native integration tests support it. |
| IOS-01 | Mitigated | Current and legacy category aliases, dequeue filtering and send-time guards implemented; upload-only setting does not block inbound data. Future unknown types retain existing forward-compatibility policy. |
| IOS-02 | Mitigated | Shared normalized contained paths and symlink checks across inbound file/skill/memory paths; native filesystem integration still required. |
| IOS-03 | Mitigated | Throwing domain outcomes, real SQL rollback/error tests, per-account CloudKit durable asset inbox-before-cursor, exact ACK/retry leases. Apple SDK/runtime and live service faults remain unverified. R1 repaired dependency progress with durable per-entry ACKs, same-record barriers, bounded resuming passes and parent ID lookup; actual domain-SQL composite regression passes. |
| IOS-04 | Mitigated | Actual single-destination frozenRecord production method tested with mutable builder/asset and SQLite restart across Env/Provider/Skill/SessionFile. |
| IOS-05 | Mitigated | Session-file remote deletion now applied with local-newer/pending protection; pure filesystem regression passed, native integration pending. |
| IOS-06 | Mitigated | Daily memory union preserves same-timestamp differing content; actual helper regression passed, end-to-end app sync pending. |
| IOS-07 | Mitigated | Shared bounded ZIP parser validates before mutation; bounds/path/CRC/size/compression checks and staging before prune. Real Swift regressions passed, Apple decompression/native import tests pending. R1 repaired Compression initializer and added native gate; whole-tree Skill swap/SQL-token journal now handles topology transitions and tested process-interruption recovery. |
| MAC-01 | Fixed | Revoke/expiry checks cover existing relay/direct streams and pending coalesced frames; independent unaffected stream and red/green runtime regressions passed. R1 batch revocation now attempts every in-memory deny before persistence can short-circuit. |
| MAC-02 | Fixed | WebFetch initial and redirected requests use existing public egress policy; focused runtime tests passed. Provider calls do not gain the public-egress policy; shared raw-response decoding also affects custom-CA/proxy adapter consumers. R1 repaired adapter null-body statuses and bounded gzip/deflate/br response decoding with actual WebFetch regression controls. |
| MAC-03 | Fixed | Strict persisted identity validation, fail-closed startup and durable management response handling with injected failures; full relay suites passed. R1 writer/migration/read validation now accepts the same compatible identity schema. |
| MAC-04 | Fixed | Repeated revocation persists again and recovers rejection queue; restart/fault regression passed. |
| MAC-05 | Mitigated | Client-owned durable immutable outbox before network, restart restore on attach, read-only receipt reconciliation, no unknown replay. Relay remains volatile; legacy/no-receipt and automatic eventual delivery require manual reconciliation. R1 integration also preserves owner identity across authenticated discovery/restart and isolates explicit endpoint/device retarget and delete→re-add changes, with regression tests. |
| AH-01 | Mitigated | Untrusted imagePath stripped only on external import; read/delete roots, formats and byte/pixel limits protected; native Harmony filesystem/decoder checks pending. |
| AH-02 | Mitigated | Normalize guest path before mount selection and canonical root containment, including write-lock checks; actual Kotlin tests pass; both native flavors pending. |
| AH-03 | Mitigated | Browser resource ownership carried through all constructor/recreation paths and draft-to-real session changes; native WebView lifecycle pending. R1 preserves sparse tab IDs/selection/next ID through migration/recreation; actual Kotlin fixture passes. |
| AH-04 | Mitigated | Unattended context enforced at actual shortcut clipboard and weather/location sinks; actual ETS VM tests pass; native permission integration pending. |
| AH-05 | Mitigated | Connected accessibility service no longer skips product ASK permission; actual method 24-case Kotlin fixture passes; native service/UI pending. |
| AH-06 | Mitigated | Remote send uses same stored history builder as local; production ETS router/engine tests pass; native app build pending. |
| AH-07 | Mitigated | Durable daily-slot claim before side effects prevents repeated failed/uncertain automatic runs; exactly-once external actions are not claimed; native background lifecycle pending. |
| AH-08 | Mitigated | Transient init retries without deleting encrypted files/keys; failure warns and memory-only commit is false; JVM tests pass; native Keystore/UI pending. |
| AH-09 | Mitigated | Atomic write+fsync+rename and sidecar CAS prevents stale metadata overwrites; fault tests pass; actual ArkTS/File.tryLock/OS crash behavior pending. R1 binds immutable encrypted secret generations to metadata identity/destination; metadata failure cannot overwrite winning credentials. Uncertain post-rename errors recover readback/cache but still report durability failure. 69 actual-store failure controls pass; native AssetStore/ArkTS gate remains open. |

## First-review repairs

- iCloud delivery now uses durable per-record completion and bounded resumable progress passes. Failed children do not block later parents or unrelated records; parent lookup is independent of the recent-query window. Same-record updates/deletes retain ordering.
- Skill imports stage whole trees and use a recoverable swap journal tied to a SQLite commit marker. Both file-to-directory and directory-to-file transitions are covered, including process restart and moved-container recovery. Apple Compression uses its explicit pointer initializer and has a real Apple SDK/runtime test gate.
- Batched revocations deny every principal even when persistence fails. WebFetch handles no-body statuses without terminating the process and bounds decoded gzip/deflate/Brotli bodies. Relay identity readers and writers agree on accepted persisted data.
- Harmony metadata references immutable credential generations bound to row identity and destination. A rejected metadata update cannot replace the winning credential. Post-rename durability errors remain errors, but reload/cache recovery tracks the visible committed generation.
- Harmony time tests run in UTC and non-UTC zones. Android browser migration preserves sparse tab identifiers, selected tab and the next identifier.
- Final review repairs also return Git worktree/content inspection to normal approval, apply relay temporary-file permissions before commit, reject uncertain secret reads before migration/copy, and persist provider model refresh through the current identity-bound row.
- Additional integration controls preserve outbox identity across authenticated host discovery and restart while isolating explicit endpoint/device retarget and delete→re-add changes. The independent Swift test target is checked under Swift 6.

## Executed source verification

The following broad counts are implementer-run results. Independent reviews also executed focused exact-source controls; they do not imply independent repetition of every aggregate suite.

- Core: 17 XCTest cases, strict Swift 6 typechecking, three actual execution fixtures for Git fsmonitor, clean-filter execution and pinned gateway arguments
- iOS portable: 5 inbound-journal tests, 5 sync-boundary tests, production SQL durability/frozen-payload tests, dependency-progress tests, and Skill transaction tests including 21 injected boundaries and 16 abrupt-process-exit/restart cases
- Mac: 75 host tests, 73 CLI tests, 57 Python tests, root/CLI typechecks, root lint (74 existing warnings, zero errors), architecture gate, changed-file lint and production Leo source builds
- Android portable: 5 Kotlin/JUnit cases, 24 permission-method cases and actual browser-session method controls
- Harmony: actual source/protocol controls, 69 metadata/credential fault cases, additional native-query migration/copy failure controls, OAuth and outgoing MCP generation tests, and all protocol/security/release-note commands in UTC, Shanghai and Los Angeles timezones
- Entry-point/version audits, iOS release/motion/visible-control scripts, workflow YAML parsing and the complete Git diff whitespace check

Counts above identify individual suites; composite/subset cases must not be added together as a single total. Portable fixtures exercise real production methods with explicit platform adapters. They do not replace platform SDK builds.

### Known local verification limits

- Supplemental whole-CLI lint still reports 47 observed maximum-file-size errors in unchanged debug/bootstrap/adapters files. Changed files pass their targeted lint. No broad refactor was introduced to hide this baseline debt.
- The local sandbox rejects the `tsx` CLI Unix IPC pipe in the bootstrap chain. Equivalent component source builds pass via `node --import tsx`. CI runs the ordinary source bootstrap command.
- Full distribution assembly stages/downloads runtime assets and is distinct from source compilation. Runtime bundles, signing, installation, release packaging and physical-device tests are not established by these source-build results.
- Native Apple SDK/Compression and simulator results must come from the exact published commit CI. Full iOS app/iSH/Watch builds, Keychain integration, actual SSH devices, Android device/WebView behavior, Harmony DevEco/HAP/AssetStore behavior and physical-device acceptance remain separate gates.

Same-device explicit grant replacement retains pending intents for read-only reconciliation. If the replacement caller cannot access an earlier receipt, the item remains uncertain; this is not a promise of automatic receipt migration across credentials.

## Useful verification commands

From the repository root on macOS/Xcode:

```sh
./scripts/RunCoreSecurityTests.sh
python3 scripts/CoreExecutionSmoke.py -v
python3 scripts/CloudKitInboundDurabilityTests.py -v
bash scripts/CloudKitTransportSDKTypecheck.sh
python3 scripts/SyncBoundaryTests.py -v
bash scripts/SkillArchiveCompressionTests.sh
python3 scripts/SkillTreeTransactionTests.py
python3 scripts/CloudKitDependencyProgressTests.py
python3 scripts/SyncSQLiteDurabilityTests.py
```

Current Mac source checks (use the repository-pinned pnpm and Node versions):

```sh
cd src/mac/leophone
pnpm install --frozen-lockfile
pnpm --filter '@zcode/contracts...' build
pnpm typecheck
PATH="$PWD/node_modules/.bin:$PATH" pnpm --dir apps/zcode-cli typecheck
pnpm lint
pnpm architecture:check
pnpm leo:test:agent
node --import tsx --test packages/desktop/src/host/leo/link/*.test.ts
ZCODE_ENV=production ZCODE_PRODUCT_IDENTITY=leo PATH="$PWD/node_modules/.bin:$PATH" pnpm --dir apps/zcode-cli build
ZCODE_ENV=production ZCODE_PRODUCT_IDENTITY=leo pnpm build:bootstrap
```

Use `BUILDING.md` and the platform release checklists for full native app/release acceptance. Android Standard and Power must both pass their existing Gradle unit/lint/assemble gates.

## Data compatibility and rollback

- Keep pending outbox data. A 202 relay response is volatile admission, not proof of durable execution. Unknown/time-out/404 requests remain visible and are reconciled by the same request ID; they are not blindly resent. Legacy hosts without receipts can remain uncertain and need manual reconciliation.
- Preserve pending iCloud inbox pages/assets and Skill transaction directories together with the matching SQLite databases. Drain/recover them or perform verified full-fetch recovery before reverting to a binary that does not understand them; an old CloudKit checkpoint alone may be insufficient.
- Harmony credential-generation metadata needs a compatible reader. Do not downgrade during uncertain commits or delete retained generations as guessed cleanup.
- Existing SSH hosts require an explicitly verified public host key before connection. Verify the key through a trusted channel; do not disable host verification as a migration shortcut.
- Skill staging needs temporary disk space. Out-of-space and hidden-descendant topology conflicts defer safely. Cross-volume power-loss durability and a malicious local process concurrently swapping ancestors are not claimed covered by the process-interruption tests.
- The large-file/legacy-architecture refactor remains deferred. Unknown future sync types retain the existing forward-compatibility policy; this work does not create a new schema quarantine product contract.
