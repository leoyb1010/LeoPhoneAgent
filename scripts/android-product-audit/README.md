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

Run on a fresh prepared emulator with
`AUDIT_FLAVOR=Standard AUDIT_PROFILE=phone-light-normal bash scripts/android-product-audit/run.sh`.
Both selectors are required; run each remaining edition/profile on its own fresh
AVD rather than treating a reused system as equivalent evidence.
CI compiles before starting the emulator and splits Standard/Power across
independent jobs. Each profile uses its own freshly created standard API35
Google AVD, with the same test and screenshot APIs and no permission changes.
This isolates the profiles; it does not establish continuous hot font/display
reconfiguration. The earlier sequential-profile system_server crash remains a
failed observation, not a passed transition. Only the owned test process has an fifteen-minute per-profile
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

Actual text-layout foreground colors are checked against their semantic
backgrounds at4.5:1, in addition to the required final PNG pixel inspection.

The six exact Android cases include a deterministic immediate-dispatcher startup
regression against the real Room and JSON mirror, for empty, existing, and reopened
configuration. Shipping construction still uses Dispatchers.IO. The original four
UI journeys and seven screenshots remain required; an additional named-control
journey and eighth image verify expansion, member selection and actual touch
bounds. Semantics artifacts now contain the real descendant tree and touch bounds,
not just root configurations. This is not a TalkBack or physical device certification. The connected-test JVM is
limited to 1536 MiB to avoid competing with the emulator after precompilation.

The first completed light-phone capture exposed low-contrast active/model labels.
This sheet uses existing opaque semantic text and container foreground pairs,
without altering global theme colors or model/routing/persistence behavior.
Expand/collapse controls reserve 48dp while retaining their 28dp tonal visual,
and their current action includes the group/provider name in English and both
Chinese locales. The actual post-fix images and touch bounds remain mandatory.

Accessibility references:
- https://developer.android.com/design/ui/mobile/guides/foundations/accessibility
- https://developer.android.com/reference/kotlin/androidx/compose/ui/semantics/SemanticsNode#touchBoundsInRoot()

Before and after every screenshot, the actual Android foreground accessibility
window must belong to this fixture package. Compose visibility assertions alone
can pass behind a system ANR dialog, so a system/other-app overlay or unavailable
foreground root fails the case; the script never clicks Wait or closes system
dialogs to manufacture a clean image. The original sixty-second per-case limit
is retained, and elapsed-realtime phase markers distinguish test-body actions,
Espresso idling and screenshot waits. A full APK/UI cold-start performance claim
is explicitly outside this isolated fixture.
