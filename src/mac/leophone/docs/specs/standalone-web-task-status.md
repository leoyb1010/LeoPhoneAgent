# Standalone Web local task status projection

## Product and ownership

README's `dev:web` / `zcode --web` support a server-local workspace without Electron. The shared renderer's Home/global list currently calls an absent window-controller channel. Use the existing non-Electron Controller runtime/projection/passive sessions observer from a Node-only services export; Desktop re-exports keep its existing semantics. One server runtime owns derived task status; existing task/session services remain persistence and execution owners. There is no new task cache or filesystem API.

Declared server workspace options / ZCODE_SERVER_WORKSPACE / startup cwd → fixed local identity+normalized absolute path allowlist → read-only connection adapter → shared Controller projection → existing replayable Web RPC → list hook

## Bounds

- Capture the server declaration once at HTTP startup. Only declared local identities and normalized absolute paths match. No caller-path fallback, subdirectories, discovery, remoteSessionId, or renderer-tab-as-authority. Relative or empty caller paths reject. Remote Web remains explicitly unsupported.
- Expose only list/status plus the two existing read-only workspace/tasks-index topics. Controller mutate/delete methods reject as unsupported; existing scoped task-service mark-read/history commands stay unchanged.
- The normal `/ws` stays terminal-client/web-remote-replayable. Token middleware, one-shot host capability, provisioning restrictions and native host commands are unchanged. No new access grant or credential.
- Every connection gets an attachment emitter and owns its subscription IDs (at most 32, including in-flight admission). Resync/unsubscribe cannot reference another connection's ID. Dispose is idempotent and removes owned subscriptions; in-flight completions after close do not become accepted replies. Stop all attachments and passive listeners on HTTP server close.
- Shared Desktop default behavior is unchanged. Standalone Web requests opt into propagating source read failure rather than claiming an empty successful list; UI keeps the last successful result and retry action.
- Listing observes only existing Agent runtimes; it does not create/start a task or Agent.

## Acceptance

Synthetic direct adapter tests: normalized configured path, mismatched path/identity/remote refusal before service IO, failed first read, retry recovery, read-only mutation rejection, two-connection subscription ownership, disposal and late completion. Shared runtime via Desktop public re-export and Node export must behave equivalently with default options. Existing Desktop/agent regression suite stays enabled. Actual Web Welcome/settings/Home failed-unread → existing task history → persisted unread cleared while error/count1 remains is required; actual unpackaged Electron same journey remains required. These tests do not establish physical-device, remote-workspace, signed distribution or full filesystem parity.
