# LeoPhoneAgent functional and product audit, 2026-10-03

## Scope, baseline, and safety boundary

This is a new two-round audit of the current source, not a replay of the previous
hardening patch. Remote refs were read on 2026-10-02 UTC: main and
`codex/audit-hardening-ios-install` at `d86f567546c7f3e5f206fd89a9ebf153c8a6e27b`,
existing audit branch at `c30189e7270bb12a8abfec75f2c11e75c3b5ebeb`, and
`leo/audit-fixes-0927` at `c8d23af79a164302ec0fafa5148f4241ec7e1ac2`.
The existing audit head is an ancestor of main (0 audit-only / 3 main-only
commits); the local audit branch was fast-forwarded to the exact main baseline.
All newer user changes, binaries, submodules, and file modes are retained.
Only the existing audit branch is a publication target. No merge to main,
deployment, release, signing, real account/credential, user Mac, or production
data is part of this run. Current source versions remain iOS 1.49.2 (136),
Mac 1.3.5, Android 1.0.0-alpha.27, Harmony 0.3.0-alpha.22.

The `surface-inventory.csv` inventories 473 discoverable UI source files and
1,897 lexical control-token occurrences across iOS, Android, Harmony and selected
current Mac UI/settings/app-shell sources. These are discovery counts, not a
semantic total of buttons or proof that every control was exercised.

## Round 1: findings and repairs

1. **LP-01, pairing lifecycle, medium.** The mounted Mac phone-link panel revoked
   only credentials already received at cleanup time. Closing while the issuance
   RPC was pending let a late credential remain live until its ordinary expiry.
   QR rendering failure could also retain an invisible code. The existing
   panel now has one lifetime-scoped owner, a synchronous repeated-click gate,
   late-result cleanup, and no state updates after close. A failed replacement
   revocation blocks another issuance and warns that the old code may still
   be valid. Existing protocol/payload/expiry/device-grant formats are unchanged.
2. **LP-02, revoke result, medium.** Actual `revokePairingCode` returned success
   for HTTP 400/500/503 and exhausted authentication keys. Four new regression
   groups failed against the baseline and pass after the repair. Only 2xx/404
   is accepted; ordinary 401/403 fallback is preserved; network/HTTP failures
   propagate through the existing error contract. No credentials are logged.
3. **LP-03, status loading/error, low.** Rejected status IPC escaped the poll's
   promise and left the loading or stale success copy visible. Polls are now
   serialized, catch errors, display them, and recover on a later successful poll.
4. **LP-04, entry-point drift, low.** `RepositoryEntryPointAudit.py` failed on
   current main because the README badge said Mac 1.3.4 while the authoritative
   manifest is 1.3.5. Corrected only the badge; no product version bump.

These are conservative lifecycle, error-reporting and documentation repairs.
The source audit did not justify a broader redesign, database migration,
framework upgrade, permission change, or native feature rewrite.

## Executed evidence in this run

- Root iOS release-readiness, visible-control, and motion source gates pass.
  The visible-control gate identifies 52 allowed empty alert-dismissal actions;
  this is a static no-op check, not a native UI button-click test.
- Root entry-point audit: reproduced failure, then passes for iOS 1.49.2 (136)
  and current Mac 1.3.5.
- All Python leoagent tests: **57 pass**, including the active relay suite's
  **47 pass** (a subset, not additive). Tests use synthetic loopback services and
  temporary state, including pinning, streaming, reconnect, revocation and
  persistence failure paths.
- Harmony protocol suite passes. Production ETS boundary suite passes, including
  **69** encrypted-generation transaction/fault scenarios and **30** secret-query
  migration/retry/model scenarios. Those counters are fixture assertions/scenarios,
  not independent native-device tests.
- Harmony release-note gate passes at 0.3.0-alpha.22 / 100027.
- Focused Mac pairing transport tests: **12 pass**, including an actual relay
  one-time-code → own device key → single-use journey and new HTTP/error cases.
- New pairing lifetime unit tests: **10 pass** for close before issuance, close
  during QR, same-frame repeat, QR failure, failed-revoke retry, reopen/stale owner,
  issuance error, cleanup error and a legacy bridge without a revoke method.
- Current Mac lint: **0 errors / 74 warnings** across 2,687 files. Warnings are
  retained and are not represented as a clean zero-warning result.
- Changed-module architecture gate: **0 violations / 0 new** for current legacy
  `ui` and `desktop` modules. No baseline was rewritten.

## Round 2 and hosted verification status

Independent review of candidate `88263a59d204329cd6503f2d87890d264bbf7d77`
found no blocking runtime issue and independently repeated all 21 focused tests.
The generated inventory was normalized to LF after the reviewer caught its CRLF
diff-check warnings. A further close-during-revocation test and actual-relay
repeated-revoke/redemption check pass; the focused total is now **22 pass**.
Exact-published-SHA hosted tests and screenshots are still pending. Do not treat
this interim report as finished or release-ready.
The read-only Quality workflow now covers the existing audit branch, source
regressions, and an isolated actual-component browser fixture. The fixture uses
production React components/styles with a synthetic bridge and blocks external
network requests. Its seven screenshots cover ready, close-before-reply, visible
code, revoke failure/retry, status failure/recovery, form validation/save, and
narrow/dark layout. Screenshots count only after the CI artifact is successfully
retrieved and visually inspected. Native Electron IPC is not replaced by this
fixture; native iOS UI is not represented by a narrow browser viewport.

## Unrun, blocked, and remaining gates

- This Linux executor has no Swift/Xcode, iOS simulator, DevEco/Harmony runtime,
  Android SDK/device, or user desktop. Native permission dialogs, real storage
  upgrade, iCloud/Keychain, camera/mic/location, Watch/Siri, background execution,
  SSH handshakes and Android Standard/Power builds remain separate gates.
- Local iOS native-permission source audit cannot run: its pinned iSH submodule
  header is absent in the non-recursive checkout. No submodule pointer changed.
- Full Mac dependency install was killed with exit 137. The constrained retry
  is in progress. Local full typecheck then encountered incomplete workspace
  resolution and was killed; it is **not a passing typecheck**. The preliminary
  link-wide run has 33 passes and 3 test-file startup failures from missing
  `@zcode/shared`; these are not three demonstrated product regressions and do
  not replace the required fully-installed hosted suite.
- Local cloud browser returned ERR_BLOCKED_BY_CLIENT for the isolated loopback
  preview. The documented managed preview client is absent; no network/safety
  restrictions were changed. No local screenshot or visual claim is made.
- Revocation after a panel disappears is best effort if transport fails; the
  existing server TTL still bounds it. Old bridges without revoke retain their
  prior expiry-only behavior. This is not a claim of guaranteed offline revoke.
- App-wide accessibility conformance and all-button/runtime completeness are
  not established. Source inventory and source gates are explicitly separate
  from executable protocol and actual-component journeys.

## Reproduction and review

From `src/mac/leophone` after the repository's frozen pnpm install:

```sh
node --import tsx --test packages/ui/test/phonePairingSession.test.ts
node --import tsx --test packages/desktop/src/host/leo/link/pairing.test.ts
node --import tsx --test packages/desktop/src/host/leo/link/*.test.ts
pnpm typecheck
pnpm lint
pnpm architecture:check
node node_modules/playwright-core/cli.js install chromium
node scripts/audit-phone-link/run-journeys.mjs
```

Browser results are written only to ignored `audit-phone-link-results/`; no
fixture is imported by a production entry point. The Quality workflow uploads
its synthetic screenshots and journey ledger as a 14-day artifact. The normal
source build, platform tests and release gates remain in place.
