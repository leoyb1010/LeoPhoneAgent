# Third-Party Licenses

LeoPhoneAgent bundles, links, or depends on the following third-party components. Versions reflect the current source tree; license types were verified against each project's repository (GitHub license metadata / LICENSE files).

## Paperclip 中文服务器集成

Paperclip AI (`paperclipai/paperclip`) is pinned to commit `994d6edcdd4e15d5f9cc5cf8c135ac599104b86a` under the **MIT License**, copyright (c) 2025 Paperclip AI. The separately deployed server source is obtained and transformed by the reproducible distribution layer in `src/server/paperclip`; the original license is preserved as `LICENSE.paperclip`. Native clients implement the HTTP contract rather than bundling the upstream execution server. Product names and original notices are retained; this integration is not an upstream endorsement. The Chinese server layer also contains reviewed UI translation keys for MDXEditor 4.2.3, covered by its MIT License preserved as `src/server/paperclip/LICENSE.mdxeditor`; these labels do not transform user-authored Markdown.

## Native C/C++ dependencies (`deps/`)

| Component | Version / Source | License | Notes |
|---|---|---|---|
| [iSH](https://github.com/OpenMinis/ish-arm64) (ARM64 fork) | git submodule `deps/ish` | **GPL-3.0** (post-`0e3a414` contributions also under GPL-2.0), with an App Store distribution exception (`LICENSE.IOS`) | x86 Linux usermode emulation on iOS; core reason the app is GPLv3 |
| [proot](https://github.com/OpenMinis/proot) (fork) | git submodule `deps/proot` | **GPL-2.0-or-later** | Linux sandbox on Android (`libproot.so`, `proot-aarch64`) |
| [FFmpeg](https://ffmpeg.org) | 6.1.2, built by `deps/build_ffmpeg.sh` | **LGPL-2.1-or-later** (built without `--enable-gpl` / `--enable-nonfree`) | Dynamic frameworks on iOS; keep the LGPL configuration |
| [LAME](https://lame.sourceforge.io) | 3.100; **not in this repository** (vendored source and `deps/build_lame.sh` removed in `bf424b99`) | **LGPL-2.0-or-later** | Optional MP3 encoder: linked into FFmpeg via `--enable-libmp3lame` only when a LAME static library is supplied at `deps/lame-build/`. Clean checkouts build FFmpeg without it; any distributed build whose FFmpeg includes LAME must honor LAME's LGPL terms |
| [talloc](https://talloc.samba.org) (Samba) | vendored at `deps/talloc` | **LGPL-3.0-or-later** | Memory allocator required by proot |
| [cppjieba](https://github.com/yanyiwu/cppjieba) | vendored (iOS `Vendor/cppjieba`, Android `jieba_jni`) | **MIT** | Chinese word segmentation (header-only + dictionaries) |
| Alpine Linux 3.21.3 minirootfs | checksum-pinned by `scripts/prepare_android_sandbox.sh` | Aggregate of package licenses (musl **MIT**, BusyBox **GPL-2.0-or-later**, etc.) | Downloaded for local/CI builds and bundled as the default Android rootfs |

## iOS — Swift Package Manager dependencies

Direct packages declared in `src/ios/LeoPhoneAgent.xcodeproj`:

| Package | Version | Repository | License |
|---|---|---|---|
| SwiftAnthropic | 2.2.0 (exact) | https://github.com/jamesrochabrun/SwiftAnthropic | **MIT** |
| swift-cmark (`cmark-gfm`, `cmark-gfm-extensions`) | 0.7.1 | https://github.com/swiftlang/swift-cmark | **BSD-2-Clause** (with some MIT-licensed vendored files, see its `COPYING`) |
| SwiftMath | 1.7.3 | https://github.com/mgriebling/SwiftMath | **MIT** |
| RealTimeCutVADLibrary | 1.0.14 | https://github.com/helloooideeeeea/RealTimeCutVADLibrary | **MIT** |

Transitive packages (pinned in `Package.resolved`), all **Apache-2.0**, maintained by Apple / the Swift Server Workgroup: `async-http-client`, `swift-algorithms`, `swift-asn1`, `swift-async-algorithms`, `swift-atomics`, `swift-certificates`, `swift-collections`, `swift-crypto`, `swift-distributed-tracing`, `swift-http-structured-headers`, `swift-http-types`, `swift-log`, `swift-nio` (+ `-extras`, `-http2`, `-ssl`, `-transport-services`), `swift-numerics`, `swift-service-context`, `swift-service-lifecycle`, `swift-system`.

## Android — Gradle dependencies

| Library | Version | License |
|---|---|---|
| AndroidX / Jetpack (Compose BOM 2025.09.00, core-ktx, lifecycle, activity, navigation, Room, DataStore, security-crypto, browser, webkit, exifinterface) | see `app/build.gradle.kts` | **Apache-2.0** (Google / AOSP) |
| OkHttp + okhttp-sse | 4.12.0 | **Apache-2.0** |
| kotlinx-serialization-json | 1.7.3 | **Apache-2.0** |
| kotlinx-coroutines-android | 1.9.0 | **Apache-2.0** |
| Coil (coil-compose) | 2.7.0 | **Apache-2.0** |
| multiplatform-markdown-renderer (+ m3) — mikepenz | 0.33.0 | **Apache-2.0** |
| Reorderable (sh.calvin.reorderable) | 2.4.0 | **Apache-2.0** |
| ACRA (acra-core) | 5.12.0 | **Apache-2.0** |
| PDFBox Android (com.tom-roush:pdfbox-android) | 2.0.27.0 | **Apache-2.0** |
| Bouncy Castle Provider / PKIX / Utilities (PDFBox Android transitive) | 1.72 | **Bouncy Castle Licence (MIT-style)** |
| Shizuku API + provider (dev.rikka.shizuku) | 13.1.5 | **MIT** |

Test-only dependencies: JUnit 4.13.2 (**EPL-1.0**), MockWebServer 4.12.0 (**Apache-2.0**), kotlinx-coroutines-test 1.9.0 (**Apache-2.0**), org.json 20231013 (**Public Domain / JSON License**).

## Mac desktop subprojects (`src/mac/`)

Each Mac subdirectory keeps its own license; the GPLv3 license of the root
repository does not relicense them, and their licenses do not relicense the rest
of the repository. When distributing a binary built from one of these
directories, follow that directory's own LICENSE / NOTICE files and provide the
corresponding source under its terms.

| Directory | Origin | License | Notices to keep |
|---|---|---|---|
| `src/mac/leophone/` (current Mac 1.x) | ZCode desktop/CLI kernel, Copyright 2026 Z.AI Co., Ltd | **Apache-2.0** (`src/mac/leophone/LICENSE`) | `src/mac/leophone/NOTICE.md`, `src/mac/leophone/THIRD-PARTY-NOTICES.md` and `src/mac/leophone/third-party/` (per-dependency terms) |
| `src/mac/leocodebox/` (archived 2.2.x, fallback only) | Based on [CloudCLI UI](https://github.com/siteboon/claudecodeui) | **AGPL-3.0-or-later** with CloudCLI UI's Section 7 attribution terms (`src/mac/leocodebox/LICENSE`) | `src/mac/leocodebox/NOTICE`, which also credits [CC Switch](https://github.com/farion1231/cc-switch) (MIT, provider-switch reference), [CodexBar](https://github.com/steipete/CodexBar) (MIT, layout reference; no source bundled) and [CodexHost](https://github.com/BytePioneer-AI/codex-host) 0.4.4 (MIT, bundled `@codexhost/cli` with its own notices) |

Distribution boundary: the root project is GPL-3.0; `src/mac/leocodebox/` is an
AGPL-3.0-or-later subtree and `src/mac/leophone/` is an Apache-2.0 subtree. They
are kept as separate programs in one source repository. Anyone offering the
archived leocodebox build (including over a network, per AGPL §13) must make its
complete corresponding source available under AGPL-3.0-or-later; Apache-2.0
code from `src/mac/leophone/` that is combined into a GPL-3.0 work is
compatible one-way (Apache-2.0 → GPL-3.0), not the reverse.

## Bundled web/UI assets

| Asset | Location | License |
|---|---|---|
| KaTeX | Android `app/src/main/assets/katex/` | **MIT** |
| jieba dictionaries | iOS bundle / Android `assets/jieba/` | **MIT** (cppjieba distribution) |

## Removed / historical

- **swift-markdown-ui** (MIT) — formerly vendored under `deps/swift-markdown-ui`; no longer referenced by the Xcode project or imported by any source file, and is not part of the open-source tree.
