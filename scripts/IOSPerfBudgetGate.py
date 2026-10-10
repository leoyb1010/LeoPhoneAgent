#!/usr/bin/env python3
"""Launch / foreground performance budget gate for a device run.

Reads the two artifacts pulled from the phone after a test run:

  perf.jsonl  Library/Application Support/Diagnostics/perf.jsonl  (LeoPerf)
  day log     Library/Logs/minis-YYYY-MM-DD.log                   (LoggingManager)

  xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
    --domain-identifier com.leoyuan.leophoneagent \
    --source "Library/Application Support/Diagnostics/perf.jsonl" --destination perf.jsonl

Budgets (fail = exit 1):
  * busiest second among the first 3 s after the last launch marker  > 80 log lines
  * [FPWatcher] lines in the first 10 s after that launch              > 3
  * any `hang` >= 500 ms within 3 s of a cold launch (latest version)
  * any TextContainerGuard line after that launch                       > 0
  * fg.frame p90 (latest version, needs >= 5 samples)                   > 500 ms

The launch marker is the `[Lifecycle] [INFO] process launch` line LoggingManager
writes when capture starts at App init.

Usage: IOSPerfBudgetGate.py --perf perf.jsonl --log minis-2026-10-10.log [--version 1.61.0]
"""
import argparse
import json
import math
import re
import sys

LAUNCH_MARKER = "[Lifecycle] [INFO] process launch"
TS = re.compile(r"^\[(\d\d):(\d\d):(\d\d)\]")

BUDGET_LAUNCH_SECOND_LINES = 80
BUDGET_FPWATCHER_LINES = 3
BUDGET_LAUNCH_HANG_MS = 500
LAUNCH_HANG_WINDOW_S = 3
BUDGET_TEXT_GUARD_LINES = 0
BUDGET_FG_FRAME_P90_MS = 500
FG_FRAME_MIN_SAMPLES = 5


def seconds_of(line):
    m = TS.match(line)
    if not m:
        return None
    h, mi, s = (int(g) for g in m.groups())
    return h * 3600 + mi * 60 + s


def last_launch_segment(lines):
    """Lines from the last launch marker to the end, as (seconds, line)."""
    start = None
    for i, line in enumerate(lines):
        if LAUNCH_MARKER in line:
            start = i
    if start is None:
        return None
    out = []
    last = None
    for line in lines[start:]:
        sec = seconds_of(line)
        if sec is None:
            sec = last          # continuation line: belongs to the previous stamp
        else:
            if last is not None and sec < last - 12 * 3600:
                sec += 24 * 3600  # crossed midnight
            last = sec
        if sec is not None:
            out.append((sec, line))
    return out


def percentile(values, p):
    if not values:
        return None
    ordered = sorted(values)
    k = max(0, math.ceil(p / 100.0 * len(ordered)) - 1)
    return ordered[k]


def check_log(lines):
    results = []
    segment = last_launch_segment(lines)
    if segment is None:
        return [("launch marker present", False, "no '%s' line in the day log" % LAUNCH_MARKER)]
    t0 = segment[0][0]
    per_second = {}
    for sec, _ in segment:
        if t0 <= sec < t0 + 3:
            per_second[sec] = per_second.get(sec, 0) + 1
    busiest = max(per_second.values()) if per_second else 0
    results.append(("launch-second log lines <= %d" % BUDGET_LAUNCH_SECOND_LINES,
                    busiest <= BUDGET_LAUNCH_SECOND_LINES, "busiest second has %d lines" % busiest))
    fp = sum(1 for sec, line in segment if sec < t0 + 10 and "[FPWatcher]" in line)
    results.append(("FPWatcher lines <= %d" % BUDGET_FPWATCHER_LINES,
                    fp <= BUDGET_FPWATCHER_LINES, "%d lines in the first 10 s" % fp))
    guard = sum(1 for _, line in segment if "TextContainerGuard" in line)
    results.append(("TextContainerGuard lines <= %d" % BUDGET_TEXT_GUARD_LINES,
                    guard <= BUDGET_TEXT_GUARD_LINES, "%d lines since launch" % guard))
    return results


def load_perf(lines):
    records = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except ValueError:
            continue
    return records


def check_perf(records, version=None):
    results = []
    if version is None:
        version = next((r.get("v") for r in reversed(records) if r.get("v")), None)
    mine = [r for r in records if r.get("v") == version]
    colds = [r for r in mine if r.get("e") == "cold" and not r.get("prewarm")]
    hangs = [r for r in mine if r.get("e") == "hang"]
    bad = []
    for cold in colds:
        launch = cold["t"] - cold.get("ms", 0) / 1000.0
        for h in hangs:
            ms = h.get("ms", 0)
            began = h["t"] - ms / 1000.0
            if ms >= BUDGET_LAUNCH_HANG_MS and launch <= began <= launch + LAUNCH_HANG_WINDOW_S:
                bad.append(ms)
    results.append(("no hang >= %d ms within %d s of launch" % (BUDGET_LAUNCH_HANG_MS, LAUNCH_HANG_WINDOW_S),
                    not bad, "%d cold launch(es), offending hangs: %s" % (len(colds), bad or "none")))
    frames = [r.get("ms", 0) for r in mine if r.get("e") == "fg.frame"]
    if len(frames) >= FG_FRAME_MIN_SAMPLES:
        p90 = percentile(frames, 90)
        results.append(("fg.frame p90 <= %d ms" % BUDGET_FG_FRAME_P90_MS,
                        p90 <= BUDGET_FG_FRAME_P90_MS, "p90 %.1f ms over %d samples" % (p90, len(frames))))
    else:
        results.append(("fg.frame p90 <= %d ms" % BUDGET_FG_FRAME_P90_MS, True,
                        "skipped: %d sample(s) < %d" % (len(frames), FG_FRAME_MIN_SAMPLES)))
    return version, results


def run(perf_path, log_path, version=None, out=sys.stdout):
    with open(log_path, encoding="utf-8", errors="replace") as f:
        log_lines = f.read().splitlines()
    with open(perf_path, encoding="utf-8", errors="replace") as f:
        perf_records = load_perf(f.read().splitlines())
    version, perf_results = check_perf(perf_records, version)
    results = check_log(log_lines) + perf_results
    ok = all(passed for _, passed, _ in results)
    print("IOSPerfBudgetGate (version %s)" % (version or "?"), file=out)
    for name, passed, detail in results:
        print("  [%s] %s — %s" % ("PASS" if passed else "FAIL", name, detail), file=out)
    print("RESULT: %s" % ("PASS" if ok else "FAIL"), file=out)
    return 0 if ok else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--perf", required=True)
    parser.add_argument("--log", required=True)
    parser.add_argument("--version")
    args = parser.parse_args(argv)
    return run(args.perf, args.log, args.version)


if __name__ == "__main__":
    sys.exit(main())
