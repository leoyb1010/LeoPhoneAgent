# Leo screen view — R0 snapshot / R1 WebRTC video / R2 input contract (WP-50, WP-51, WP-52)

Status: Mac side implemented for R0 (snapshot), R1 (WebRTC video) and R2 (input control).
iOS / iPad / Watch consume this contract.

## Owners

```
iPhone ──(direct HTTPS via Tailscale Serve, or relay WS frame)──► Host LinkBridge
   GET /screen/snapshot                                            │ policy: Mac switch + scope screen.view
                                                                   │ relay: 1 fps / 200 KB
                                                                   ▼
                                       Host ScreenSnapshotService ──(unix socket, per-launch secret)──► Main
                                                                                                         desktopCapturer → JPEG
```

- Main owns capture (`main/leo/screenCapture.ts`): `systemPreferences.getMediaAccessStatus("screen")`,
  `desktopCapturer.getSources({ types: ["screen"] })`, `NativeImage.toJPEG`. Main never asks for
  the permission by itself; the Mac settings page links to System Settings.
- Host owns policy (`host/leo/link/screen/snapshot.ts`): the "允许手机查看屏幕" switch
  (`~/.leoagent/link/screen.json`, default **off**), the `screen.view` scope, ETag, relay limits.
- Nothing is stored: every request captures a fresh frame.

## Endpoint

`GET /screen/snapshot`

Query parameters (all optional):

| name | default | range | meaning |
|---|---|---|---|
| `max_edge` | 1280 | 320–2560 (relay: capped at 1280) | longest edge of the JPEG in pixels |
| `q` | 0.6 | 0.3–0.9 | JPEG quality |
| `display` | primary | Electron display id (digits) | which screen |
| `if_none_match` | — | ETag string as returned | same as the `If-None-Match` header; use it on the relay path where request headers are not forwarded |
| `format` | `jpeg` (direct) / `json` (relay) | `jpeg` \| `json` | direct path may ask for the JSON form too |

### Direct path (`https://<mac>.ts.net/screen/snapshot`)

Headers: `Authorization: Bearer <direct grant token>`, `X-Leo-Device-Id: <Mac device id>`
(same as every direct call; the grant needs the existing `harness` scope). Optional
`If-None-Match: "<etag>"`.

- `200` — body is `image/jpeg`. Headers: `ETag: "<32 hex>"`, `X-Leo-Screen-Width`,
  `X-Leo-Screen-Height`, `X-Leo-Screen-Display`, `X-Leo-Screen-Captured-At` (unix ms),
  `Cache-Control: no-store`.
- `304` — frame unchanged (ETag equal); empty body, `ETag` header repeated.
- No rate limit on the direct path; poll at ~1.5 s while foreground (R0 plan).

### Relay path (`GET <relay>/relay/api/m/<machine>/screen/snapshot?...`)

The relay carries JSON only, so the response body is:

```json
{
  "etag": "\"3f…\"",
  "content_type": "image/jpeg",
  "width": 1280, "height": 800, "display_id": "1",
  "captured_at": 1792213314960,
  "bytes": 141233,
  "data_base64": "/9j/4AAQ…"
}
```

- Unchanged frame → status `200`, body `{ "etag": "\"3f…\"", "not_modified": true }` (no image).
  The relay answers with `web.json_response`, which cannot carry a body on a real 304.
- Limits: at most **1 request per second per device** (`429`, see errors) and at most
  **200 KB** JPEG per frame. Over 200 KB the Mac re-encodes up to twice (quality ×0.7 and
  edge ×0.8 each time); still too big → `413`.
- Only poll while the iPhone app is in the foreground.

## Errors

Error bodies use the existing link shape `{ "error": { "message": "<中文>", "code": "<code>" } }`.

| status | code | when | client action |
|---|---|---|---|
| 403 | `screen_disabled` | Mac switch 「允许手机查看屏幕」 is off | show "在 Mac 的 设置 → 连接手机 → 屏幕 打开" |
| 403 | `screen_scope_required` | caller is not an iPhone/iPad-class device (legacy / unknown relay caller) | re-pair the device |
| 428 | `screen_permission` | macOS Screen Recording permission not granted to LeoBot | show "到 Mac 上允许屏幕录制"; retry later |
| 429 | `rate_limited` | relay path faster than 1 fps; body also has `retry_after_ms` | wait `retry_after_ms` |
| 413 | `frame_too_large` | relay frame still > 200 KB after re-encoding | use direct, or lower `max_edge` |
| 404 | `display_not_found` | `display` does not exist | drop the parameter |
| 503 | `capture_unavailable` | Mac app not running a window / capture failed | retry with backoff |

## Scope `screen.view`

Derived, not stored in grants: allowed when the caller kind is `iphone` (iPhone and iPad register
as this kind over the relay), `master`, or a direct-QR-paired device (grant kind `legacy` with a
`direct-…` device id). Denied for relay `legacy` clients without a device key and for `unknown`.
Combined with the Mac switch above.
R2 input control uses a separate scope `screen.control` (see R2 below).

## R1 — WebRTC video (`/screen/session`)

Video never goes through the relay: the relay (and the direct port) carry only the small JSON
signalling below; media flows peer-to-peer over WebRTC (SRTP, DTLS-fingerprint pinned in the SDP).

### Owners

```
iPhone (libwebrtc, offerer / ICE controlling)
   │ POST /screen/session {offer}            ── direct HTTPS or relay JSON ──►  Host ScreenSessionService
   │ ◄── {session_id, answer, ice_servers}                                        │ switch + screen.view, one viewer,
   │ POST /screen/session/:id/ice {candidates}                                    │ tailnet-only, ICE ranking, TURN creds
   │ GET / DELETE /screen/session/:id                                             ▼  (unix socket POST /peer)
   │                                                                   Main: hidden BrowserWindow (partition leo-screen-peer)
   ◄════════════ SRTP video (H.264, VideoToolbox) / DataChannel ═══════  getDisplayMedia → SCK capture → RTCPeerConnection
```

- Main (`main/leo/screenMediaHandler.ts`, `preload/leoScreenPeer.ts`): a never-shown window with its
  own in-memory session; `setDisplayMediaRequestHandler` picks the screen directly (no system
  picker). One PeerConnection at a time; the window is destroyed when the last session ends.
  Capture is ScreenCaptureKit (verified: `SCStream` in the browser process stack while streaming),
  encoder is VideoToolbox H.264 (`encoderImplementation: "VideoToolbox"`, `powerEfficientEncoder: true`).
- Host (`host/leo/link/screen/session.ts`, `ice.ts`): policy, state, ICE rewriting, TURN creds.

### `GET /screen/session` — preflight

`200 { "ice_servers": [ … ], "tailnet_only": false, "control": false }` — call it before creating the
iOS `RTCPeerConnection` so the offer already contains relay candidates when TURN is configured
(`control` = whether an input channel would be granted right now). Same 403s as below.

### `POST /screen/session` — open

Direct path needs `X-Request-Id` like every direct POST, but screen signalling is **not** stored in
operation receipts (no replay; SDP is never written to disk).

Request:

```json
{
  "offer": "v=0\r\n…",       // required, ≤ 64 KB; must contain a recvonly video m-line
  "display": "1",              // optional Electron display id (digits); default primary
  "max_fps": 30,               // optional 1–60, default 30
  "max_edge": 1920,            // optional 640–4096, default 1920 (long edge, capture-side scaling)
  "control": true              // optional: ask for the R2 input channel (granted only if allowed)
}
```

Offer requirements (iOS `RTCPeerConnection`):

- `addTransceiver(.video, init: direction = .recvOnly)`; put H.264 first with
  `setCodecPreferences` (the Mac also forces H.264 on its sender via `encodings[0].codec`, so a
  VP8-first offer still ends up on H.264 when the offer contains it).
- For R2, create the data channel **before** the offer: label `"leo-input"`, `ordered: true`.
- Use `bundlePolicy: .maxBundle`, `rtcpMuxPolicy: .require`. Trickle is fine (non-trickle offers
  with candidates in the SDP also work).
- Set `RTCRtpReceiver.jitterBufferTarget = 0` (or the libwebrtc equivalent) — screen viewing does not
  need smoothing; it saves ~50–100 ms.

`200` response:

```json
{
  "session_id": "scr_<uuid>",
  "answer": "v=0\r\n…",             // complete: all Mac candidates are in it (no Mac→phone trickle)
  "ice_servers": [                    // pass to the iOS RTCConfiguration before setRemoteDescription;
    { "urls": ["stun:mini:3478"] },   // empty when no TURN is configured or tailnet-only is on
    { "urls": ["turn:mini:3478?transport=udp"], "username": "1792…:leobot", "credential": "…" }
  ],
  "expires_at": 1792217158000,        // unix ms: connect before this or the Mac closes the session
  "control": false,                   // true = the "leo-input" channel will be accepted (R2)
  "tailnet_only": false,
  "candidate_tiers": ["tailnet", "tailnet", "lan", "srflx"]   // Mac candidates in the answer, best first
}
```

`ice_servers` TURN credentials are short-lived (default 1 h, coturn REST `use-auth-secret`); the
shared secret stays on the Macs (`~/.leoagent/link/turn.json`, see `src/mac/leoagent/turn/README.md`).
The answer repeats the `ice_servers` the Mac itself uses; normally take them from the preflight.

### ICE order and "只走 Tailscale"

Path preference: **tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48) → LAN → STUN reflexive → coturn relay**.
The Mac is the controlled agent, so it rewrites the priorities of its own candidates in the answer
(RFC 8445 formula, type preference tailnet 126 > LAN 110 > other host 100 > srflx 90 > relay 10, UDP
before TCP) and sorts them. Chromium's mDNS host names (`<uuid>.local`) are resolved back to real
addresses first — mDNS does not work across Tailscale. iOS should order its own candidates the same way.

Mac setting 「只走 Tailscale」 (`tailnet_only: true`): `ice_servers` is empty, the answer keeps only
tailnet candidates, and LAN / public / mDNS candidates the phone sends (in the offer or via `/ice`)
are dropped. If the Mac has no Tailscale address the open fails with `503 no_tailnet_path`.

### `POST /screen/session/:id/ice` — trickle

```json
{ "candidates": [ { "candidate": "candidate:… typ host …", "sdpMid": "0", "sdpMLineIndex": 0 } ] }
```

1–50 candidates per call; `""` (end-of-candidates) is accepted. `200 { "ok": true, "accepted": n,
"dropped": m }` (dropped = malformed or filtered by tailnet-only).

### `GET /screen/session/:id` — status and stats

```json
{
  "session_id": "scr_…", "state": "connected",          // new | connecting | connected | disconnected | closed
  "encoder": "VideoToolbox", "power_efficient_encoder": true, "codec": "video/H264",
  "frame_width": 1918, "frame_height": 1240, "frames_per_second": 30,
  "frames_encoded": 812, "bytes_sent": 4012345, "total_encode_time": 2.1,
  "quality_limitation": "none", "rtt_ms": 3,
  "local_candidate": "host 100.81.83.56", "remote_candidate": "prflx 100.70.0.9"
}
```

### `DELETE /screen/session/:id` — close

`200 { "ok": true }`. Also closed by the Mac when: not connected within 30 s (`expires_at`), ICE
`failed`, `disconnected` for more than 15 s, the same device opens a new session, or the Mac user
turns off 「允许手机查看屏幕」 / 「允许手机操控」 / turns on 「只走 Tailscale」.

### Errors (in addition to the R0 table)

| status | code | when |
|---|---|---|
| 400 | `bad_offer` / `bad_candidates` | malformed body |
| 404 | `session_not_found` | unknown, ended, or another device's session (ids are not confirmed) |
| 405 | `method_not_allowed` | |
| 409 | `session_limit` | another device is already viewing (one viewer at a time; the same device replaces its old session) |
| 422 | `negotiation_failed` | the Mac could not apply the offer (no video m-line, no common codec, capture failed) |
| 428 | `screen_permission` | macOS Screen Recording not granted |
| 503 | `no_tailnet_path` | tailnet-only on, but the Mac has no Tailscale address |
| 503 | `capture_unavailable` / `peer_unavailable` | Mac app window / capture service not available |

`/v1/capabilities` → `features.screen_session: true` when the Mac supports R1 (still subject to the switch).

### iOS client checklist

1. `GET /v1/capabilities`; show the video entry only when `features.screen_session`.
2. `GET /screen/session` → create `RTCPeerConnection` with its `ice_servers`.
3. Build the offer (recvonly video, H.264 first, optional `leo-input` channel), `POST /screen/session`,
   `setRemoteDescription(answer)`; trickle local candidates to `/ice` in batches.
4. Render with `RTCMTLVideoView`; picture-in-picture via `AVPictureInPictureController` +
   `AVSampleBufferDisplayLayer`; stop (DELETE) when the app goes to the background.
5. Poll `GET /screen/session/:id` every few seconds only for the status line (encoder, fps, path).

### Measured (dev, Mac side, 2026-10-17)

Local test client = headless Chrome 155 (libwebrtc) on the same Mac, `jitterBufferTarget = 0`,
`max_edge` 1920 (capture 1918×1240), see `scripts/leo-screen-test/client.mjs`:

| metric | result | target |
|---|---|---|
| encoder / capture | VideoToolbox H.264 (power-efficient) / ScreenCaptureKit | VT, SCK |
| glass-to-glass (screen change → decoded frame, loopback) | median 104 ms, p90 120 ms (n = 93) | ≤ 120 ms tailnet |
| answer → first frame | 0.48–0.6 s | — |
| bitrate, busy desktop 30 fps | ~1.0 Mbps (dynamic), ~0.47 Mbps (only background animations) | static ≤ 300 kbps |
| Mac CPU while streaming (all LeoBot processes, % of one core) | 10.8 % (main 1.1, GPU 3.7, renderer 5.3, utility 0.6) | ≤ 15 % |
| native Retina capture (3456×2234) | ~1.1–1.6 Mbps, latency ~220 ms → why `max_edge` defaults to 1920 | — |

Not yet measured: a truly static desktop (the dev machine always had UI animations), real tailnet /
TURN paths from an iPhone, 30-minute stability, iPhone battery.

## R2 — input control (`leo-input` DataChannel, WP-52)

Off by default. Allowed only when the Mac switch 「允许手机操控」 is on **and** the caller passes the
`screen.view` device check (scope `screen.control`, derived, not stored in grants). Turning the
switch off closes running sessions immediately.

### Channel

- The phone creates the data channel before the offer: `createDataChannel("leo-input", ordered: true)`
  (reliable, ordered — text must not be lost or reordered) and sends `"control": true` in
  `POST /screen/session`.
- If the response has `"control": false`, the Mac closes the channel as soon as it opens: view only.
- Messages are UTF-8 JSON strings, ≤ 16 KB each, one event per message. The Mac validates every event
  (`main/leo/screenInputCore.ts`): unknown shapes are dropped silently, coordinates clamped to 0–1,
  scroll to ±5000 px, text to 2000 characters per message (control characters other than `\n` / `\t`
  are removed).

### Events (phone → Mac)

Coordinates `x` / `y` are **normalized 0–1 relative to the video frame** (= the captured display),
top-left origin. Map from the `RTCMTLVideoView` content rect, not the view bounds.

| event | fields | notes |
|---|---|---|
| `{"t":"move","x":…,"y":…}` | | sends a drag instead while a button is held |
| `{"t":"down","b":"left","x":…,"y":…}` / `{"t":"up",…}` | `b`: `left` \| `right` \| `middle` (default left); `x`/`y` optional (last position) | press-and-hold, drag |
| `{"t":"click","b":"left","n":1,"x":…,"y":…}` | `n`: 1–3 (double / triple click) | |
| `{"t":"scroll","dx":0,"dy":-120,"x":…,"y":…}` | pixels; `dy > 0` = finger moved up = content scrolls down | two-finger pan |
| `{"t":"key","code":"KeyC","mods":["cmd"],"phase":"press"}` | `code`: W3C `KeyboardEvent.code` (letters, digits, punctuation, F1–F17, arrows, Enter, Tab, Space, Backspace, Delete, Escape, Home/End/PageUp/PageDown, numpad, modifier keys); `mods`: `cmd` `shift` `alt` `ctrl`; `phase`: `press` (default) \| `down` \| `up` | shortcuts; iPad `GCKeyboard` → map HID usage to `code` |
| `{"t":"text","s":"你好 hello"}` | any Unicode | IME-independent: inserted as text, not key presses; send long text in several messages |

### Mac → phone (same channel)

`{"t":"status","ok":true|false,"reason":null|"accessibility"|"helper_missing"}` — sent when the
injector starts and whenever the Accessibility permission changes. `ok: false` with
`reason: "accessibility"` means macOS drops injected events: show 「到 Mac 上给 LeoBot 打开辅助功能权限」.

### Mac side

- `main/leo/screenInput.ts`: when a session's `leo-input` channel opens, starts
  `Contents/Resources/leo-input/leo-input serve --display <id>` (Swift, `native/leo-input/main.swift`,
  built by `scripts/build-leo-input.mjs`, arm64); events go to its stdin as JSON lines and are posted
  with `CGEvent` (`.cghidEventTap`) in order on one serial queue. Text uses
  `keyboardSetUnicodeString` in ≤ 20-UTF-16-unit chunks split on grapheme boundaries.
- While controlled: a red dot 「正在被控制」 in the menu bar (its menu has 「立即断开」), and the
  helper watches the local keyboard: **Esc pressed three times within 1.5 s** on the Mac closes all
  screen sessions. Injected events carry `eventSourceUserData = 0x4C454F` and are ignored by this
  watcher, so an Esc sent from the phone never disconnects.
- Permission: Accessibility for LeoBot (injection and the Esc watcher). Settings shows a
  「辅助功能权限 · 去系统设置」 row while 「允许手机操控」 is on and the permission is missing.
- When the channel closes or the session ends the helper releases any held mouse button and exits.

### Keys iPadOS keeps for itself

Known: ⌘Tab, ⌘Space, ⌘H, ⌘⇧3/4/5 and Globe shortcuts are taken by iPadOS before `GCKeyboard`
sees them; the iOS toolbar sends them as `key` events instead (the iOS side owns the full list).

### Measured (dev, 2026-10-17)

Safe target only (test windows opened for the test, events posted to that process with the
dev-only `LEO_INPUT_TEST_PID` → `--target-pid`; never the user's apps):

- 500 mixed Chinese / English characters in 5 text events → 500 / 500 arrived in order, 0 lost.
- `Enter`, `Shift+←`, `Backspace`, `Cmd+A`, `Cmd+S`, `Cmd+W`, `Escape` arrived with the right modifiers
  (TextEdit saved and closed the test file).
- Mouse events could not be verified this way: AppKit / Chrome ignore mouse events posted to a
  process; real delivery needs the global HID path, which moves the user's cursor — not run.
- Esc×3 needs the physical keyboard (injected Escs are deliberately ignored) — not run.

## Mac settings

设置 → 我的设备 → 连接手机 → 屏幕: 「允许手机查看屏幕」 (default off), 「只走 Tailscale」 (default off),
「允许手机操控」 (default off, R2), the Screen Recording permission state and a button to open Privacy &
Security › Screen Recording. Stored in `~/.leoagent/link/screen.json`
(`{version: 2, enabled, tailnet_only, control}`).

## Verification

- `node --import tsx --test packages/desktop/src/host/leo/link/screen/snapshot.test.ts`
  (ETag/304, relay rate limit and size cap, permission / switch / scope branches).
- `node --import tsx --test packages/desktop/src/host/leo/link/screen/ice.test.ts
  packages/desktop/src/host/leo/link/screen/session.test.ts` (ICE tiers / ranking / tailnet-only /
  TURN creds; R1 state machine: open, ice, stats, delete, one viewer, ownership, control).
- `node --import tsx --test packages/desktop/src/main/leo/screenInputCore.test.ts` (R2 event validation).
- R2 end-to-end (dev): start the dev app with `LEO_INPUT_TEST_PID=<pid of a test window you opened>`,
  turn on 「允许手机操控」, then `node scripts/leo-screen-test/client.mjs --grant … --control --input events.json`.
- R1 end-to-end (dev): `node scripts/leo-screen-test/client.mjs --grant <direct grant json>
  [--latency] [--seconds 10]` against the dev direct port.
- Manual: direct port with curl (`-H "Authorization: Bearer …" -H "X-Leo-Device-Id: …"`), second
  call with `If-None-Match` returns 304.
