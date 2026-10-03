# Native iOS model-management audit

This is a test-only iPhone Simulator app assembled from production SwiftUI
files, production model Codable types, routing, pinning, and model-selection
logic. It has no entitlements, signing, package dependencies, Watch target, iSH,
network execution, real credentials, CloudKit, or user configuration.

## Run

On the pinned hosted macOS/Xcode runner used by `.github/workflows/ios-tests.yml`:

```sh
brew install xcodegen # only if absent
bash scripts/native-model-audit/run.sh 3c053a7c9b112667a04cea9b12c7c16a03c5ce39 baseline
bash scripts/native-model-audit/run.sh WORKTREE current
```

`NATIVE_AUDIT_DESTINATION` can select an installed iPhone Simulator. The workflow
uses iPhone 17 Pro / iOS 26.5 with Xcode 26.6 and saves both versions separately.
No build, archive, signing, release, or deploy step for the product is involved.

## Evidence and boundaries

- `source-manifest.json` records exact git reference, source paths, SHA-256, and
  every extraction/transformation. Baseline view files come from immutable git
  blobs even after the worktree implementation changes
- Actual `UnifiedModelPicker`, `QuickModelSwitchSheet`, `SessionModelPicker`,
  model-group screens, and onboarding model selection render in SwiftUI
- The improved provider catalog is the complete actual `ProviderModelCatalogView`, including native search, filters, favorites, bulk visibility confirmation, and append-to-group flows
- Baseline provider catalog uses the exact original private rendering method
  bodies in an explicit fixture wrapper. It is evidence for native catalog rows,
  not for the entire provider screen or authentication workflow
- `FixtureStore.swift` supplies deterministic data and app-sandbox JSON
  persistence. Pin storage uses the real production `ModelSwitcher` through
  isolated standard defaults. Persistence assertions prove this fixture seam and
  production model codecs, not production SQLite or iCloud migration
- Authentication availability is synthetic. A non-secret sentinel stands in for
  a credential in the test process. No live model calls or speech tests occur
- The UI tests capture `XCUIScreenshot` PNG attachments and accessibility trees.
  `xcresulttool` exports them alongside test summaries and the complete log
- Catalog selection after import is exercised; file-picker/import transport,
  production database startup, iSH, Watch, networking, and real-device behavior
  remain outside this isolated harness. Do not describe its green result as a
  full product build or release validation

## Journeys

Quick and full picker baselines, favorites, provider catalog, groups/defaults,
190-entry catalog search, long names at accessibility3 text size, no-results and
empty catalog, pin without switching, pin/selection persistence across process
relaunch, direct-vs-group identity, unchanged default after session selection,
onboarding group creation, Home draft isolation, System voice rows, duplicate-name selection identity, unavailable groups, explicit member selection retaining its group, and catalog bulk hide/show/add-to-group preserving favorites and defaults. Codec tests preserve custom names, identifiers
containing `/` and `:`, overrides, group order, unresolved references, and binding
kind. The current app also runs production `ModelCatalogTests` when present.

Generated projects/results are build artifacts and are not committed.
