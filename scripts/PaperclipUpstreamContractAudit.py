#!/usr/bin/env python3
"""Check the exact upstream implementation evidence used by native adapters.
This is a source-contract check, not an HTTP end-to-end test.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

PIN = "994d6edcdd4e15d5f9cc5cf8c135ac599104b86a"
root = Path(sys.argv[1]).resolve() if len(sys.argv) == 2 else None
if root is None:
    raise SystemExit("用法：python3 scripts/PaperclipUpstreamContractAudit.py /path/to/pinned-paperclip")
actual = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
if actual != PIN:
    raise SystemExit("上游版本与客户端契约不一致，拒绝自动接受变更")
checks = [
    ("human-session", "server/src/middleware/auth.ts", ['opts.deploymentMode === "authenticated"', "opts.resolveSession(req)"]),
    ("create-retention", "server/src/services/issues.ts", ["ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS = 7", "issue-create:idempotency:${companyId}:${idempotencyKey}", "pg_advisory_xact_lock", "issueCreateIdempotencyKeys.idempotencyKey, idempotencyKey"]),
    ("comment-dedup", "server/src/services/issues.ts", ["issueComments.issueId, issueId", "issueComments.authorUserId, actor.userId", "issueComments.clientRequestId, options.clientRequestId", "Message request ID was already used for different content"]),
    ("historical-runs", "server/src/routes/activity.ts", ['router.get("/issues/:id/runs"', "svc.runsForIssue(issue.companyId, issue.id)"]),
    ("cancel-run", "server/src/routes/agents.ts", ['router.post("/heartbeat-runs/:runId/cancel"']),
    ("create-comment-routes", "server/src/routes/issues.ts", ['"/companies/:companyId/issues"', '"/issues/:id/comments"']),
    ("accessible-companies", "ui/src/api/companies.ts", ['"/companies?scope=accessible"']),
    ("board-session", "ui/src/api/auth.ts", ['"/api/auth/get-session"', 'credentials: "include"']),
    ("artifact-route", "server/src/routes/issues.ts", ['`/api/attachments/${attachment.id}/content`']),
    ("license", "LICENSE", ["MIT License", "Copyright (c) 2025 Paperclip AI"]),
]
results = []
for name, path, needles in checks:
    data = (root / path).read_bytes()
    source = data.decode()
    missing = [needle for needle in needles if needle not in source]
    if missing:
        raise SystemExit(f"合约变化：{name} ({path})，缺少 {missing}")
    results.append({"name": name, "path": path, "sha256": hashlib.sha256(data).hexdigest(), "status": "passed"})
print(json.dumps({"kind": "pinned-source-contract", "commit": PIN, "checks": results, "limits": ["源代码契约核对，不代表真实服务器端到端或模型执行通过"]}, ensure_ascii=False, indent=2))
