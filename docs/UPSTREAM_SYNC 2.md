# Upstream synchronization

LeoPhoneAgent keeps OpenMinis as the read-only `upstream` remote. Import one
upstream release at a time; do not mix an upstream merge with product features.

```sh
git remote -v
git fetch upstream --tags
git switch codex/leophoneagent-1.0
git merge --no-ff upstream/main
```

Resolve conflicts in this order:

1. Preserve LeoPhoneAgent bundle IDs, URL schemes, signing team and artwork.
2. Preserve version policy and GPL/provenance documentation.
3. Accept upstream runtime and security fixes where they do not remove a fork feature.
4. Rebuild native dependencies when their scripts, submodules or versions change.
5. Run the unsigned generic-device build, then the signed device build.

Audit after every import:

```sh
rg -n 'com\.openminis|minis://' src/ios
xcodebuild -project src/ios/LeoPhoneAgent.xcodeproj \
  -scheme LeoPhoneAgent -configuration Debug \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
```

An upstream merge may legitimately retain internal `Minis*` type names and
`minis-*` shell commands. Review customer-facing copy, identifiers and network
metadata separately from internal compatibility names.
