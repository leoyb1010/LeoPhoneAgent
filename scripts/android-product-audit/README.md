# Android product UI fixture

This test compiles and displays the production `ModelPickerSheet`, its normal
theme and models, on a disposable Google Android emulator. Both Standard and
Power Debug flavors run the same synthetic provider/group journeys. Screenshots
come from Android `UiAutomation`, not HTML re-creations.

The opt-in `leophone.auditUiFixture=true` property selects an x86_64 Debug build
and a plain `Application` runner. It cannot be used for a release task. All
ordinary ARM64 builds keep their original runner and ABI. No APK is uploaded or
published. No device credentials, signing keys, user files or live providers are
used. PRoot assets and full `MinisApp` startup are deliberately outside this
fixture, so it provides no evidence of device cold-start, upgrades, fold posture
transitions, sandbox execution, native permissions or full chat integration.

Profiles use the documented Fold8 cover/open pixel sizes, phone/tablet layout,
light/dark, normal/reduced system animation and 100%/200% system font size. These
are emulator layout profiles, not Fold8 device certification. One run is a
bounded part of one full repository audit round, never a replacement for five
independent whole-product rounds.

Run on a prepared emulator with `bash scripts/android-product-audit/run.sh`.
CI compiles before starting the emulator and splits Standard/Power across
independent jobs. Only the owned test process has an fifteen-minute per-profile
limit; any timeout remains a failure. Device boot plus package/activity service
health is checked before each profile, and a system failure or missing complete fresh
JUnit result stops remaining profiles instead of repeating against a broken emulator.
The screenshot output uses AGP's additional-test-output collection, before AGP
uninstalls the test package. No post-uninstall access or new storage permission
is required. `AUDIT_FLAVOR=Standard` or `Power` selects one CI shard.
Each profile/flavor preserves Gradle/JUnit evidence, screenshots and provenance;
any test or screenshot-collection failure makes the aggregate fail. Initial
coverage is active fallback member versus defaults, cross-group selection,
search/clear and collapsed providers, hidden entries, empty search, dismissal,
reopening and large-font long labels. Further rounds must add newly challenged
states while repeating the full applicable product matrix.

References:
- https://developer.android.com/develop/ui/compose/testing
- https://github.com/ReactiveCircus/android-emulator-runner
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- https://kotlinlang.org/docs/compiler-execution-strategy.html
- https://developer.android.com/topic/performance/benchmarking/benchmarking-in-ci

The five exact Android cases include a deterministic immediate-dispatcher startup
regression against the real Room and JSON mirror, for empty, existing, and reopened
configuration. Shipping construction still uses Dispatchers.IO. The original four
UI journeys and seven screenshots remain required. The connected-test JVM is
limited to 1536 MiB to avoid competing with the emulator after precompilation.
