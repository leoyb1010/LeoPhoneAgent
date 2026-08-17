# LeoPhoneAgent agent instructions

These rules apply to the whole repository.

1. Read the root `README.md`, especially **开发 Agent 先读** and
   **Android Agent 交接与发布铁律**, before changing Android code.
2. Work from the canonical `main` checkout. Inspect `git status`, fetch
   `origin`, and preserve unknown local changes. Never use destructive reset to
   make the tree look clean.
3. Android ships both Standard and Power. Changes under `src/android/app/src/main`
   require verification of both flavors; Power-only privileges must not leak
   into Standard.
4. Never publish an Android APK unless the repository signer gate, upgrade
   install from the previous usable version, Fold8 cold starts, Logcat scan,
   version checks and asset digest checks all pass. A green build or CI run is
   not sufficient.
5. Never change the expected signer fingerprint to accommodate a new machine's
   debug key. Never commit, print, encode or upload signing secrets.
6. Update README and CHANGELOG with every public product release. Keep claims
   separated into source review, build/test evidence, and real device/emulator
   evidence.
