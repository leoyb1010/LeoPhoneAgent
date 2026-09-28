# Paired-device persistent sync replica v1

An explicitly configured `SyncReplicaStore` owns replica SQLite state. It is not a task runtime, command queue, or local business database. The caller validates pairing and sync authorization before routing requests; authenticated device identity supplies sender identity. All peers authorized for this replica can read its synced data. No unauthenticated routing, no global storage or network configuration, no credential logging.

```mermaid
sequenceDiagram
  participant Phone
  participant AuthenticatedRoute
  participant ReplicaSQLite
  Phone->>AuthenticatedRoute: upload hash-addressed chunks
  AuthenticatedRoute->>ReplicaSQLite: commit bounded chunks; verify final SHA256
  Phone->>AuthenticatedRoute: changes with stable changeId + revision
  AuthenticatedRoute->>ReplicaSQLite: validate assets; transaction receipts + latest + increment log
  ReplicaSQLite-->>AuthenticatedRoute: FULL synchronous commit
  AuthenticatedRoute-->>Phone: per-change durable ACK
  Phone->>AuthenticatedRoute: changes after durable cursor
  AuthenticatedRoute-->>Phone: bounded page including tombstones
```

Wire: POST `/sync/v1/changes` accepts `{changes:[{changeId,revision,id:{type,id},operation,updatedAt,record?}]}`. Upserts carry a PortableRecord-shaped record; `fields` and `unknownFields` preserve `{t,v}` tagged values. Dates use Swift JSONEncoder default seconds since 2001-01-01. Assets replace local `fileURL` with `{key,sha256,size,mimeType?}`. No local paths cross this boundary. Deletes omit record. Receipt is `{changeId,revision,status:stored|superseded,cursor}`. Duplicate same sender/changeId/body returns the prior receipt after restart; changed reuse rejects 409. Per-sender object revisions suppress older retries. Higher same-sender revisions supersede its own prior winner even if its wall clock moves backward. Cross-sender clock skew remains a limitation of the existing wall-clock conflict contract; clients must surface superseded outcomes and pull the winning record. Cross-sender conflicts use timestamp, deletion wins ties, then sender/changeId deterministic tie-break. Unknown fields survive unchanged.

GET `/sync/v1/changes?after=0&limit=100` returns `{replicaId,changes:[{cursor,senderDeviceId,change}],nextCursor,hasMore}`. Replica identity is persistent; clients must reset cursor and reconcile when identity changes. Cursors beyond current log reject rather than silently skipping. Tombstones and change logs are retained; there is no unsafe collection while offline clients may exist.

PUT `/sync/v1/assets/{sha256}` accepts a chunk <=1 MiB with `Content-Range: bytes start-end/total`. For an empty file use `Content-Range: bytes */0`. A failed hash check does not mark completion; `Upload-Reset: true` at offset 0 restarts an incomplete upload if an earlier chunk was corrupt, and never deletes a complete asset. HEAD returns `Upload-Offset`, `Upload-Length`, `X-Asset-Complete`. Final chunks validate full SHA256 before completion; changes referencing incomplete/missing or size-mismatched assets fail without ACK. GET supports one standard byte Range, including suffix ranges, and returns immutable content with ETag and Content-Range. Chunks are persisted transactionally in SQLite, so resume and crash recovery share the same durability boundary. Maximum asset 256 MiB, JSON batch 4 MiB/100 changes. No deletion/GC is performed by v1.

Client retries use the same changeId and revision. Success confirms this replica destination only. CloudKit confirmation remains independent. Business application, unsupported-schema quarantine, own-sender loop suppression and domain conflict semantics remain the client merger's responsibility. Replica storage does not decrypt allowed encrypted secret fields, nor authorize additional secret categories. Local-only OAuth tokens and SSH private keys are excluded by the client sync builders.


## Existing Treasury tools over direct connection

The separately authorized `treasury` scope serves GET `/treasury/v1/tools` and POST `/treasury/v1/call/{treasury_search,treasury_get,treasury_save,treasury_update}`. `createTreasuryHandler` receives the host's existing TreasuryStore; it does not construct another owner or business database. Existing executeTreasuryTool validation, explicit `user_confirmed` write gate, on-demand body projection and untrusted-content labels are preserved. No local administration `/api` route is exposed. Writes must not be automatically retried across paths: the legacy save operation creates a fresh item ID and does not have a durable request-ID contract.

These local note/link tools are distinct from portable ArtifactV2/ArtifactVersionV2 replication. They do not imply incremental artifact business state, attachment Range routes or deletion semantics that TreasuryStore does not currently provide. Artifact bytes use the hash-addressed sync replica path; the existing client artifact merger remains authoritative.
