# iOS device routing contract

This release targets iOS/iPadOS and Mac. Android/Harmony work is excluded by the latest user instruction.

## Authoritative pairing

Authenticated relay target `POST /direct-grants` returns a `device` descriptor using the shared `schemaVersion: 1` / UUID `deviceId` contract and a `grant` containing `token`, `targetDeviceId`, epoch-seconds `expiresAt`, and optional `scopes`. Legacy omitted scopes mean harness only. Scoped tokens remain in non-synchronizing local Keychain, separate from relay credentials. Descriptor metadata is persisted with the existing host without replacing its display name or enabled flag.

A QR beginning `leoagent-direct:v1|` contains `apiRoot`, a single-use `join`, `exp` and `deviceId`. Redemption uses `/direct-pair` and no relay bearer. The returned identity must match the QR; the granted HTTPS endpoint is then checked using authenticated `/v1/capabilities` before a business request. A direct-only host has no imaginary relay fallback.

A verified UUID may associate an existing gateway host with new endpoints. Names and IP addresses never merge device identities. SSH association is an explicit selection in the existing SSH editor; SSH credentials do not become remote-control grants. Deletion records the known UUID and legacy alias to avoid rediscovery resurrection.

## Routing and failure behavior

- Direct credentials never follow HTTP redirects and are never replaced with a relay bearer on a direct URL.
- The original relay request is retained unchanged while a candidate direct URL, scoped grant, and target header are substituted.
- A 3-second identity probe is cached for 30 seconds. A failed direct route has a 30-second cooldown. Direct requests use an 8-second request timeout; discovery uses 5 seconds. These are pre-device-test bounds, not measured end-to-end latency claims.
- A mutation uses one `X-Leo-Request-Id` on the relay and the same ID in `X-Request-ID` on direct. The direct descriptor must advertise `operation-receipts` before a mutation is attempted.
- Transport failures and HTTP 502/503/504 may use the relay. Business/authentication 4xx responses are returned without mutation replay.
- SSE task and `after` cursor are unchanged across transports. The existing session driver owns reconnect and deduplication; URL/network stream errors put direct into cooldown.
- UI reports application direct/relay path and observed response RTT. It does not infer Tailscale DERP/P2P from `.ts.net` or IP addresses.

## Replica and Treasury boundaries

`replicaReady()` requires an unexpired scoped grant and the `sync-replica-v1` capability. `replicaData` accepts only `/sync/v1/*`, keeps the supplied operation ID and uses authenticated direct transport only. The relay does not expose this database and never receives replica bodies as a fallback. The caller owns revisions, ACK validation, retry queues and record conflict handling.

Existing relay event/APNs catch-up and incremental Treasury/body/attachment code continues to use its established relay service. `GatewayRelayServices` explicitly records that service root; parsing `/m/` is confined to migrating older saved hosts. The new Mac `/treasury/v1/call` note-tool service is not substituted for the existing artifact/version/Range sync contract.

Direct-only pairing does not manufacture a relay credential. Existing relay-paired hosts retain notification/catch-up behavior; a phone paired only through the new direct QR has foreground direct access but has not thereby enrolled a relay/APNs subscription. This must be reflected in final device testing and capability claims.

## Evidence

- `scripts/DirectRouteSmoke.swift` executes production descriptor validation, identity pinning, expiration, direct QR expiry, scopes and HTTPS credential boundaries.
- `scripts/DirectRoutingIntegrationSmoke.swift` compiles the production `LeoAgentRouting.swift` extension with an isolated host shell and URLProtocol fault injection. It verifies wrong target receives no mutation, direct/relay credentials stay separate, 503 retains operation ID, 403 does not replay, SSE keeps `after=41`, and a harness grant does not enable sync.
- No physical-device installation was performed for intermediate builds. Full app build, actual target identity/serve configuration, final one-time installation, task restart/notification and network transition checks remain the parent release gates.
