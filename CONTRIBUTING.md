# Contributing to LeoPhoneAgent

LeoPhoneAgent is an independent GPLv3 fork focused first on a strong iOS
product. Bug reports, focused pull requests and design discussions are welcome
in the [LeoPhoneAgent repository](https://github.com/leoyb1010/LeoPhoneAgent).

## Before opening a change

- Keep unrelated product changes in separate commits.
- Preserve the LeoPhoneAgent identity table in
  [the 1.0 baseline](docs/LEOPHONEAGENT_1.0_BASELINE.md).
- Do not remove GPL or third-party notices.
- Explain any new entitlement, background mode, external service or collected data.
- For upstream imports, follow [UPSTREAM_SYNC.md](docs/UPSTREAM_SYNC.md).

## Verification

For iOS changes, build the generic device target and state whether signing was
enabled. Changes that touch iSH, FFmpeg, LAME or the rootfs must rebuild the
affected native artifacts. Include device/OS details for runtime bugs.

Android source is present, but Android release work is currently deferred; do
not assume an Android change has been validated unless the pull request includes
the relevant Gradle and device test results.

## License

Contributions are accepted under GPLv3. By submitting a contribution, you
confirm that you have the right to provide it under that license.
