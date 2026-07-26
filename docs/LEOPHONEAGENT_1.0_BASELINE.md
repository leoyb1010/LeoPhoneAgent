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
| Development team | `48H5Y3LNUK` |
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

The 1.0 upstream launcher limitation was removed in 1.0.1: the client now targets the
LeoPhoneAgent-owned GitHub Pages path and the launcher source is maintained at
`docs/launch.html`.

## Build verification

Verified locally on macOS with Xcode 26.6 (17F113):

- LAME 3.100 device ARM64 static library: passed
- FFmpeg 6.1.2 device ARM64 frameworks with LAME: passed
- iSH ARM64 libraries, headers and VDSO: passed
- Alpine Linux 3.21.0 aarch64 fakefs rootfs: passed
- Xcode generic iOS device build with signing disabled: **passed**
- Main app, Share, File Provider, Widget and App Intents metadata: **passed**
- Signed automatic-provisioning build for paired iPhone 17 Pro Max: **passed**
- Generated profile team and application identifier: `48H5Y3LNUK` / `48H5Y3LNUK.com.leoyuan.leophoneagent`: **verified**

Unsigned verification command:

```sh
xcodebuild -project src/ios/LeoPhoneAgent.xcodeproj \
  -scheme LeoPhoneAgent -configuration Debug \
  -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO build
```

Signed-device verification command:

```sh
xcodebuild -project src/ios/LeoPhoneAgent.xcodeproj \
  -scheme LeoPhoneAgent -configuration Debug \
  -destination 'id=2A6E7C6F-45DD-5B4F-8D08-1BD1037D353B' \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=48H5Y3LNUK build
```

Xcode automatically created the required development profiles and signed the
main app, Share extension, File Provider extension and Widget extension.

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
