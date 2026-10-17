# Leo screen view — R0 snapshot contract (WP-50)

Status: Mac side implemented (R0). iOS / iPad / Watch consume this contract. R1 signalling
(`/screen/session`) is reserved below and not implemented yet.

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
R2 input control will use a separate scope `screen.control` (not granted by anything yet).

## Reserved for R1 (WebRTC, not implemented)

Small JSON over either path; video never goes through the relay.

- `POST /screen/session` body `{ "offer": "<SDP>", "display": "1", "max_fps": 30 }` →
  `200 { "session_id": "scr_<uuid>", "answer": "<SDP>", "ice_servers": [ … ], "expires_at": … }`
- `POST /screen/session/:id/ice` body `{ "candidates": [ { "candidate": "…", "sdpMid": "0", "sdpMLineIndex": 0 } ] }` → `204`
- `DELETE /screen/session/:id` → `204`
- Same errors as above, plus `409 session_limit` (one viewer at a time).

## Mac settings

设置 → 我的设备 → 连接手机 → 屏幕: switch 「允许手机查看屏幕」 plus the current Screen Recording
permission state and a button to open Privacy & Security › Screen Recording.

## Verification

- `node --import tsx --test packages/desktop/src/host/leo/link/screen/snapshot.test.ts`
  (ETag/304, relay rate limit and size cap, permission / switch / scope branches).
- Manual: direct port with curl (`-H "Authorization: Bearer …" -H "X-Leo-Device-Id: …"`), second
  call with `If-None-Match` returns 304.
