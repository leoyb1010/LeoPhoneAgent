# LeoPhoneAgent 1.0 baseline

This document freezes the first independently branded iOS baseline before
LeoPhoneAgent-specific feature development begins.

## Provenance

- Fork: <https://github.com/leoyb1010/LeoPhoneAgent>
- Upstream: <https://github.com/OpenMinis/OpenMinis>
- Base commit: `9cf3a855fecd27bb5735b84cacbd56852a3ab8dd`
- Product branch: `codex/leophoneagent-1.0`
- License: GPLv3; distributed binaries require corresponding source and notices

## Identity

| Item | 1.0 value |
|---|---|
| Product / scheme | `LeoPhoneAgent` |
| Marketing version | `1.0` |
| Build number | `1` |
| Development team | `54UB8X9C5F` |
| Main bundle ID | `com.leoyuan.leophoneagent` |
| Share extension | `com.leoyuan.leophoneagent.ShareExtension` |
| File Provider | `com.leoyuan.leophoneagent.FileProvider` |
| Widget | `com.leoyuan.leophoneagent.AgentWidget` |
| App Group | `group.com.leoyuan.leophoneagent` |
| iCloud container | `iCloud.com.leoyuan.leophoneagent` |
| Primary deep link | `leophoneagent://` |
| MCP OAuth callback | `leophoneagent-mcp://` |

Internal `/var/minis`, `minis-*` sandbox commands, type names and some extension
target names remain in 1.0 for upstream and stored-data compatibility. They are
not public brand identifiers and should be migrated only with an explicit data
and script compatibility plan.

The iOS “Add to Home Screen” web-app flow still uses the upstream
`openminis.app/launch.html` compatibility launcher in 1.0. Replace that endpoint
with a LeoPhoneAgent-controlled HTTPS domain before a public distribution; iOS
web clips need an HTTPS handoff page before returning through the custom scheme.

## Build verification

Verified locally on macOS with Xcode 26.6 (17F113):

- LAME 3.100 device ARM64 static library: passed
- FFmpeg 6.1.2 device ARM64 frameworks with LAME: passed
- iSH ARM64 libraries, headers and VDSO: passed
- Alpine Linux 3.21.0 aarch64 fakefs rootfs: passed
- Xcode generic iOS device build with signing disabled: **passed**
- Main app, Share, File Provider, Widget and App Intents metadata: **passed**
- Signed automatic-provisioning build: pending Xcode account login

Unsigned verification command:

```sh
xcodebuild -project src/ios/LeoPhoneAgent.xcodeproj \
  -scheme LeoPhoneAgent -configuration Debug \
  -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO build
```

After signing into the Apple ID that owns team `54UB8X9C5F` in Xcode →
Settings → Accounts, create/register the App Group and iCloud container if the
portal does not do so automatically, then run:

```sh
xcodebuild -project src/ios/LeoPhoneAgent.xcodeproj \
  -scheme LeoPhoneAgent -configuration Debug \
  -destination 'generic/platform=iOS' \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=54UB8X9C5F build
```

The certificate is present locally, but a certificate alone cannot create new
provisioning profiles; Xcode needs a valid logged-in developer account session.

## Native-build path note

The upstream iSH Meson generator does not safely quote every source path. If
the repository path contains a space, build iSH from a temporary copy whose
path has no spaces and synchronize `libs/`, `include/` and `resources/` back,
or clone the repository into a space-free development directory. Xcode itself
does handle the current path correctly.

## Platform scope

iOS is the 1.0 product priority. Android source and preliminary LeoPhoneAgent
namespace/brand scaffolding are retained, but Android native dependencies,
Gradle packaging, signing and runtime testing are deferred to a later milestone.

## Next product phase

Start LeoPhoneAgent-specific changes from this tagged baseline and keep them in
small, reversible commits. Prioritize onboarding and permissions, provider
setup reliability, task observability, privacy controls, and iPhone background
execution behavior before expanding Android release work.
