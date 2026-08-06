#!/usr/bin/env python3
"""Cindy Desktop「仅运行脚本」Python 客户端的最小接入脚本。

拷走 protocol.py / maker_client.py / demo.py 后修改 demo 即可接入。运行方式见
同目录 README.md。

演示三件事:
  1. 读取 host 下发的任务上下文(scheduleId / runId / workingDir 等)
  2. 按任务授予的能力调 host RPC(未授权时优雅降级,不让整轮失败)
  3. 诊断输出走 stderr、结果走 complete 帧(stdout 是协议通道,不能 print——
     protocol.py 已做 fd 级兜底,但不要依赖它)
"""

import sys

import maker_client


def log(*args) -> None:
    """诊断输出:一律 stderr(host 截留 64KB 进日志,任务失败时可在
    apps/desktop/logs/main-*.log 的 [script-runner] 条目里看到)。"""
    print(*args, file=sys.stderr)


def main() -> None:
    # 首次 RPC 前想拿上下文,可显式握手(call/emit_complete 也会自动握手)
    maker_client._client._ensure_started()
    ctx = maker_client._client.context
    log(f"schedule={ctx.get('scheduleName')} run={ctx.get('runId')} cwd={ctx.get('workingDir')}")

    summary: list[str] = []

    # 能力按任务勾选授予,默认全拒。先自省(免授权)拿 granted,按需分支——
    # 比盲调撞 CAPABILITY_DENIED 更清晰。
    granted = set(maker_client.host_capabilities()["granted"])
    log(f"granted={sorted(granted)}")

    if "jira.read" in granted:
        issue = maker_client.jira_issue_get("DING-1", fields=["summary"])
        summary.append(f"jira ok: {issue}")
    else:
        summary.append("jira skipped (not granted)")

    if "feishu.read" in granted:
        msgs = maker_client.feishu_recent_messages("oc_replace_me", count=5)
        summary.append(f"feishu ok: {len(msgs.get('messages', []))} messages")
    else:
        summary.append("feishu skipped (not granted)")

    # 结果文本会显示在自动化的运行历史里(截断保留 8KB)
    maker_client.emit_complete("; ".join(summary))


if __name__ == "__main__":
    main()
