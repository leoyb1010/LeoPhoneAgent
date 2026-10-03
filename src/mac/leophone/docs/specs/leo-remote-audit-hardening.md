# Remote authorization and transport hardening

## Owners and invariants

The relay owns relay identities; `DirectGrants` owns the Mac's durable direct
grants and revocations. `LinkBridge` and the existing runtime remain the only
command admission owners. Transport subscriptions are projections, not tasks.

```
revoke → identity owner denies in memory → abort matching subscriptions
       → persist revocation → report durable success
stream frame → current authorization check → transport write
```

Revocation, including a failed persistence attempt, stops already-open streams
and discards relay coalescing buffers. Other devices and the underlying task
continue. Direct streams revalidate the actual grant, including expiry, before
each data/heartbeat write. Relay streams revalidate their authenticated principal
without extending a credential merely because a stream remains open.

Repeated revocation must retry persistence. Relay revocation snapshots retry
previously failed writes before accepting further commands; failures remain
visible and block admission. No controller may emit after it is aborted.
One snapshot is a batch: DirectGrants denies every listed principal in memory
before its durable write starts. A failed write must not leave later principals
authorized through direct HTTP/SSE. Retry persists the entire uncommitted batch;
an unrelated principal remains usable.

## Identity persistence

The registry's permission change is a pre-commit operation on its temporary
file descriptor. A fresh pin is acknowledged only after that descriptor is
restricted, flushed, and renamed into place. No fallible permission operation
may run after the rename and turn a committed pin into a reported rollback:
that would leave an undisclosed secret in the authoritative registry.
Pre-commit failures retain the old registry and allow a safe registration retry.
This ordering is not a claim of power-loss directory-fsync durability.

A missing initial relay state is distinct from an unreadable, malformed or
unsupported existing state. Existing state must validate as a complete v2
registry before any remote admission; corruption fails startup and requires
trusted local recovery. It must never silently restore unlimited master access.
Legacy device-key migration preserves its source until the new registry's file
flush and atomic rename succeed. Credential issuance and machine pinning are
acknowledged only after those operations. Failed new pin issuance is rolled back and the connection closes;
no machine key or active machine is advertised. Revocations/expiry restrictions
stay fail-closed in memory after a write failure.
The writer validates the same complete schema before opening a temporary file.
Machine names retain the existing nonempty-string domain, including names longer
than 256 characters; upgrading an otherwise valid old registry must preserve
these pins. New non-string registration names are rejected before pin mutation.
Non-finite legacy expiry aborts migration without consuming its source or
publishing a version-2 registry. A zero-grace rotation whose write fails may
require trusted local recovery because the master is already denied in memory;
the API does not promise a remote retry in this case.

## WebFetch

Every WebFetch GET, including each permitted redirect, sets `egressPolicy:
"public"` on the existing HTTP port. The Node adapter owns DNS validation,
connection-bound lookup and proxy restrictions. Literal URL checks remain a
first layer, not a substitute for the adapter's network boundary. Provider HTTP
does not gain the public-egress policy. The shared raw-response helper also
serves custom-CA/proxy adapter requests, so its decoding and response-conversion
semantics apply to those consumers too.
The raw public HTTP response path preserves fetch-compatible gzip, deflate and
brotli decoding. The response limit bounds decoded bytes, and cancellation or
decode/size errors close the source stream. Null-body statuses (204/205/304) and
HEAD use a null body. Header/status conversion and stream errors reject the
request instead of escaping an asynchronous response callback. Normal plain
responses, redirects, cancellation and supported compression remain covered
alongside the DNS/public/proxy restrictions.

## Offline delivery boundary

The existing relay offline queue is volatile. A 202 is not a runtime operation
receipt and does not establish durable admission. Do not add a second durable
business queue here. iOS now owns a durable outbox for follow-up inputs:

```text
phone immutable intent fsync → existing HTTP/relay transport → Mac admission/receipt
          ↑                                          ↓
          └──── restart/attach + read-only receipt reconciliation ────┘
```

The client persists the original request ID and immutable payload before network
IO, scoped to the configured host/device/endpoint and session. A 202 or lost reply
retains the entry. Missing relay records, timeouts, expired queues, unknown Mac
receipts and re-pairing are not proof of non-execution and never trigger blind
replay. Only a definitive response for the matching request clears the intent;
the pre-existing full-auto downgrade may retry with a new ID after definitive403.
The console restores retained input on attach/resume and shows unconfirmed state.
Legacy Macs without receipts require manual inspection. This prevents silent
input loss; it is not a promise of automatic delivery after relay restart or
exactly-once external side effects.

## Regression acceptance

- Active relay/direct streams stop on revoke; buffered deltas and status frames
  are discarded, and another device's stream remains usable
- Direct expiry blocks the next write; idle expiry is bounded by the heartbeat
- A failed revoke followed by a successful retry survives registry restoration
- Invalid state, malformed identity fields and failed migration cannot enable
  admission or overwrite the original evidence
- Failed rotate/pin operations do not claim durable success
- WebFetch wiring sends public policy on initial and redirect requests; the
  real adapter rejects private/mixed DNS results before making a socket
- A multi-device revoke with a failed write denies every affected direct token
  and stream, preserves a third device, and survives retry/restart
- Raw WebFetch 204/205/304 and malformed responses do not crash the process;
  plain/gzip/deflate/brotli content, corrupt data, decoded limits and cancellation
  use the ordinary caller result/error contract
- 256/257-character names and existing long-name pins round-trip; invalid
  migrated timestamps cannot create an unloadable registry or consume the source

## CI closure, 2026-10-03

SSH host-key discovery retains its existing public-file-only owner and accepted
algorithms. Both parsed fields must exist before regex validation; malformed or
missing files produce no key. No protocol, identity, or trust policy changes.
The isolated Swift security harness includes the existing test-only logger shim
so production outbox tests compile without the app crash-reporting dependency.
