# CloudKit schema and session provenance

## Release gate

`python3 scripts/CloudKitSchemaAudit.py --write-manifest docs/specs/icloud-schema-v1.json`
regenerates the versioned contract from the registered Swift descriptors, transport zone map and actual query keys. The format version is 1; each record type has its own wire version (SessionV2 is now 2). Transport-added schema metadata and the three hydrator asset families are included. The script fails if registry coverage is incomplete or a descriptor kind is unsupported. Asset injection changes need a corresponding manifest extractor review.

Indexes are only required where actual query predicates or sorting use them: date fields in fetchRecentV2 and sessionId for session backfill. This does not blanket-index titles, contents, credentials or all metadata fields. Zone names describe the client's private database placement; CloudKit type schema itself is container-wide.

A manifest generated from source is **not proof of deployment**. Export/review the target environment in CloudKit Console and normalize the observed definitions into this read-only evidence format:

```json
{
  "container": "iCloud.com.leoyuan.leophoneagent",
  "database": "PRIVATE",
  "environment": "Production",
  "types": {
    "SessionV2": {
      "fields": { "sessionId": { "type": "STRING" } },
      "indexes": { "sessionId": ["QUERYABLE"] }
    }
  }
}
```

This shortened example intentionally fails readiness. Supply all actual fields and indexes. Native types use STRING, INT64, TIMESTAMP and ASSET. Keep the original Console export/screenshot alongside the normalized evidence; do not copy the expected manifest and claim it was observed.

Then run:

```sh
python3 scripts/CloudKitSchemaAudit.py --environment Production \
  --observed-schema /absolute/path/to/reviewed-production-schema.json \
  --app /absolute/path/to/final-signed/LeoPhoneAgent.app
```

Exit 0 requires both schema evidence and the signed app's actual environment, CloudKit service and container entitlement. Missing inputs, missing business types (including a Users-only Production), wrong field types, absent required indexes and environment mismatches fail closed with HOLD. No credentials are read or printed. This script never deploys, resets a container, creates user records, changes environment or migrates data.

Existing Development installs remain Development. Production deployment is a distinct release action after difference review; Development user records do not automatically migrate. Final signing verification and reviewed Console evidence remain necessary even after unit tests pass.

## Creation source versus latest editor

SessionV2 schema 2 adds optional `originDeviceId` and `lastWriterDeviceId`; older readers ignore them and older writers may omit them. SQLite stores them as `origin_device_id` and `last_writer_device_id` independently of transport. Only actual new local session creation stamps the creator. Known nonempty V1 `remote_origin_device_id` can backfill creation source; legacy NULL or empty V2 origin remains unknown. No migration guesses the current device was the creator.

A known creator survives edits and legacy writeback. A remote record may fill an unknown creator, but cannot replace an established one. Latest editor follows an accepted newer session record. An accepted legacy edit without writer metadata clears the writer to unknown; stale edits cannot replace it. Local mutation methods stamp writer; dirty scheduling, snapshot staging, retries and transport changes do not. Deletions continue using existing session/tombstone rules.

The V2 session list reads source metadata from the canonical sessions table and resolves a display name using the device directory. Missing names fall back to a short device ID. Missing creator is labeled 来源未知. Local source is not repeated on every row. V2 source-group navigation uses the already merged local session, rather than trying to reopen it from legacy remote_sessions.

## Validation

```sh
python3 scripts/CloudKitSchemaAuditTests.py
python3 scripts/SessionProvenanceIntegrationTests.py
swiftc -parse-as-library src/ios/Agent/Sync/V2/SessionProvenanceStore.swift \
  scripts/SessionProvenanceSmoke.swift -o /tmp/leophone-origin-smoke
/tmp/leophone-origin-smoke
```

The provenance smoke uses real isolated SQLite rows for repeat migration, old unknown origins, known remote origins, immutable creator, stale/new writer handling and local edit without invented provenance. The integration check executes the actual production session-list SQL against an isolated fixture. Schema tests include a Users-only Production, wrong environment, missing index and wrong field type. These are automated checks, not real-device or deployed-schema evidence. Final iPhone/iPad rendering, cross-device update propagation and signed build gate are performed once after the full plan is ready.
