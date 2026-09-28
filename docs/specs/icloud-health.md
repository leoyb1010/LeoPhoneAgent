# CloudKit health and diagnostics

The CloudKit transport owns observed network health. SyncCore owns dispatcher
lifecycle and pending work; `isRunning` must not be presented as cloud health.

Health is starting before any successful operation, unavailable after an
unrecovered whole-operation error, degraded while individual query/record/zone
errors remain, and healthy only after contact with no outstanding errors.
Success clears its own operation. A successful connection probe does not clear
an unrelated failed upload. Record-level errors are distinct from service errors.

Diagnostics contain only operation, timestamp, NSError domain/code, underlying
domain/code, validated request UUID and HTTP status. Never serialize arbitrary
userInfo, error descriptions, record IDs, paths or secrets to the status UI.

Settings retain the native Form layout. Show health, pending count, last
successful send/fetch, retry deadline and affected types. Manual check is routed
through the same transport and respects server-issued retry-after. Do not infer
that a VPN, Apple account, or every other device is broken from error 15 alone.

Acceptance: initialization failure stays locally usable without showing healthy;
one missing type is degraded while other data flows; later success repairs only
the corresponding failure; sensitive NSError fields never reach diagnostic text.
