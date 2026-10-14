#!/usr/bin/env python3
r"""Launch / foreground / streaming performance budget gate for a device run.

Reads the two artifacts pulled from the phone after a test run:

  perf.jsonl  Library/Application Support/Diagnostics/perf.jsonl  (LeoPerf)
  day log     Library/Logs/minis-YYYY-MM-DD.log                   (LoggingManager)

  xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
    --domain-identifier com.leoyuan.leophoneagent \
    --source "Library/Application Support/Diagnostics/perf.jsonl" --destination perf.jsonl

Budgets (FAIL = exit 1):
  * launch-second log lines, measured over EVERY launch marker in the day log
    (busiest second among the first 3 s after each marker):
      median over all launches                                          > 80
      worst of the most recent 10 launches                              > 150
  * [FPWatcher] lines in the first 10 s after the LAST launch marker    > 3
  * any `hang` >= 500 ms within 3 s of a foreground cold launch
    (latest version; `prewarm` and `bg` cold events are not user launches and are excluded)
  * any TextContainerGuard line after the LAST launch (except the per-session
    background summary)                                                  > 0
  * fg.frame p90 over the most recent 30 samples, all versions pooled   > 500 ms
  * scroll.hitch p90 over the most recent 30 samples, all versions pooled
    (needs >= 20 samples)                                               > 20 ms/s
  * main-thread hang >= 250 ms while streaming (latest version)         > 0

A budget that cannot be evaluated is reported as WARN, never as PASS: too few
samples, no foreground cold launch, hang records from a build that predates the
`stream` flag, or no chat send in scope. WARN keeps the exit code at 0 but the
final line then says "PASS WITH WARNINGS" and lists what was NOT evaluated.

The launch marker is the `[Lifecycle] [INFO] process launch` line LoggingManager
writes when capture starts at App init. It is written for background launches too
(the day log cannot tell them apart), so a launch-heavy background day lowers the
median; perf.jsonl `cold.bg` is what separates them.

Usage: IOSPerfBudgetGate.py --perf perf.jsonl --log minis-2026-10-10.log [--version 1.61.0]
  --version pins every perf budget to that build; without it the latest build in
  perf.jsonl scopes the per-build checks and fg.frame / scroll.hitch pool all builds.
"""
import argparse
import json
import math
import re
import sys

LAUNCH_MARKER = "[Lifecycle] [INFO] process launch"
TS = re.compile(r"^\[(\d\d):(\d\d):(\d\d)\]")

PASS, FAIL, WARN, INFO = "PASS", "FAIL", "WARN", "INFO"

# Launch-second lines: the old single budget (80) now applies to the MEDIAN launch, and a
# separate ceiling (about 2x) applies to the worst of the most recent launches, so one noisy
# launch among the last ten cannot hide behind a quiet last one.
BUDGET_LAUNCH_SECOND_LINES_P50 = 80
BUDGET_LAUNCH_SECOND_LINES_MAX = 150
LAUNCH_RECENT_N = 10
LAUNCH_LINES_WINDOW_S = 3
BUDGET_FPWATCHER_LINES = 3
BUDGET_LAUNCH_HANG_MS = 500
LAUNCH_HANG_WINDOW_S = 3
BUDGET_TEXT_GUARD_LINES = 0
BUDGET_FG_FRAME_P90_MS = 500
FG_FRAME_WINDOW = 30          # K: most recent fg.frame samples, all versions pooled
FG_FRAME_MIN_SAMPLES = 5
BUDGET_SCROLL_HITCH_P90 = 20  # ms of hitch per second of scrolling
SCROLL_HITCH_WINDOW = 30
SCROLL_HITCH_MIN_SAMPLES = 20
BUDGET_STREAM_HANGS = 0
STREAM_HANG_MIN_MS = 250      # HangCounter.thresholdMs on the device


class Result(object):
    """One budget outcome: status is PASS / FAIL / WARN (not evaluated) / INFO (no budget)."""

    def __init__(self, name, status, detail, notes=()):
        self.name = name
        self.status = status
        self.detail = detail
        self.notes = list(notes)

    @property
    def passed(self):
        return self.status == PASS


def seconds_of(line):
    m = TS.match(line)
    if not m:
        return None
    h, mi, s = (int(g) for g in m.groups())
    return h * 3600 + mi * 60 + s


def launch_segments(lines):
    """One list of (seconds, line) per launch marker, in file order.

    A segment runs from its marker to the next marker (or the end). Seconds keep
    increasing across midnight so a day log that wraps stays ordered.
    """
    segments = []
    current = None
    last = None
    for line in lines:
        sec = seconds_of(line)
        if sec is None:
            sec = last          # continuation line: belongs to the previous stamp
        else:
            if last is not None and sec < last - 12 * 3600:
                sec += 24 * 3600  # crossed midnight
            last = sec
        if LAUNCH_MARKER in line:
            current = []
            segments.append(current)
        if current is not None and sec is not None:
            current.append((sec, line))
    return segments


def last_launch_segment(lines):
    """Lines from the last launch marker to the end, as (seconds, line)."""
    segments = launch_segments(lines)
    return segments[-1] if segments else None


def busiest_second(segment, window=LAUNCH_LINES_WINDOW_S):
    """Most log lines in any single second among the first `window` s of a launch."""
    if not segment:
        return 0
    t0 = segment[0][0]
    per_second = {}
    for sec, _ in segment:
        if t0 <= sec < t0 + window:
            per_second[sec] = per_second.get(sec, 0) + 1
    return max(per_second.values()) if per_second else 0


def percentile(values, p):
    if not values:
        return None
    ordered = sorted(values)
    k = max(0, math.ceil(p / 100.0 * len(ordered)) - 1)
    return ordered[k]


def check_log(lines):
    segments = launch_segments(lines)
    if not segments:
        return [Result("launch marker present", FAIL, "no '%s' line in the day log" % LAUNCH_MARKER)]
    results = []

    # Every launch in the log, not just the last: a quiet last launch used to hide
    # noisy earlier ones (the audit's median was 77 lines while the last launch had 46).
    per_launch = [busiest_second(s) for s in segments]
    recent = per_launch[-LAUNCH_RECENT_N:]
    p50 = percentile(per_launch, 50)
    worst = max(recent)
    results.append(Result(
        "launch-second log lines p50 <= %d" % BUDGET_LAUNCH_SECOND_LINES_P50,
        PASS if p50 <= BUDGET_LAUNCH_SECOND_LINES_P50 else FAIL,
        "median busiest second over %d launch(es) is %d lines" % (len(per_launch), p50)))
    results.append(Result(
        "launch-second log lines max(last %d) <= %d" % (LAUNCH_RECENT_N, BUDGET_LAUNCH_SECOND_LINES_MAX),
        PASS if worst <= BUDGET_LAUNCH_SECOND_LINES_MAX else FAIL,
        "worst of the last %d launch(es) has %d lines (oldest to newest: %s)"
        % (len(recent), worst, ", ".join(str(n) for n in recent))))

    # The remaining log budgets describe the run under test: the last launch.
    segment = segments[-1]
    t0 = segment[0][0]
    fp = sum(1 for sec, line in segment if sec < t0 + 10 and "[FPWatcher]" in line)
    results.append(Result("FPWatcher lines <= %d" % BUDGET_FPWATCHER_LINES,
                          PASS if fp <= BUDGET_FPWATCHER_LINES else FAIL,
                          "%d lines in the first 10 s" % fp))
    # The once-per-session background summary is intended diagnostics, not a
    # layout loop; only per-event guard lines count against the budget.
    guard = sum(1 for _, line in segment
                if "TextContainerGuard" in line and "session summary" not in line)
    results.append(Result("TextContainerGuard lines <= %d" % BUDGET_TEXT_GUARD_LINES,
                          PASS if guard <= BUDGET_TEXT_GUARD_LINES else FAIL,
                          "%d lines since launch" % guard))
    return results


def load_perf(lines):
    records = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def _t(record):
    value = record.get("t", 0)
    return value if isinstance(value, (int, float)) else 0


def _ms(record):
    value = record.get("ms", 0)
    return value if isinstance(value, (int, float)) else 0


def version_notes(samples):
    """Per-version p50 / p90 of `samples`, most recently seen build first."""
    by_version = {}
    for r in samples:
        by_version.setdefault(r.get("v") or "?", []).append(r)
    ordered = sorted(by_version.items(), key=lambda kv: max(_t(r) for r in kv[1]), reverse=True)
    return ["%s: n=%d p50=%.1f p90=%.1f" % (version, len(rs), percentile([_ms(r) for r in rs], 50),
                                           percentile([_ms(r) for r in rs], 90))
            for version, rs in ordered]


def check_launch_hangs(mine, version):
    """No long hang right after a foreground cold launch of this build."""
    cold_events = [r for r in mine if r.get("e") == "cold"]
    bg = [r for r in cold_events if r.get("bg")]
    prewarm = [r for r in cold_events if r.get("prewarm") and not r.get("bg")]
    colds = [r for r in cold_events if not r.get("prewarm") and not r.get("bg")]
    name = "no hang >= %d ms within %d s of launch" % (BUDGET_LAUNCH_HANG_MS, LAUNCH_HANG_WINDOW_S)
    if not colds:
        return Result(name, WARN,
                      "NOT EVALUATED: no foreground cold launch recorded for version %s (excluded: %d bg, %d prewarm)"
                      % (version or "?", len(bg), len(prewarm)))
    hangs = [r for r in mine if r.get("e") == "hang"]
    bad = []
    for cold in colds:
        launch = _t(cold) - _ms(cold) / 1000.0
        for h in hangs:
            ms = _ms(h)
            began = _t(h) - ms / 1000.0
            if ms >= BUDGET_LAUNCH_HANG_MS and launch <= began <= launch + LAUNCH_HANG_WINDOW_S:
                bad.append(ms)
    return Result(name, PASS if not bad else FAIL,
                  "%d foreground cold launch(es) (excluded: %d bg, %d prewarm), offending hangs: %s"
                  % (len(colds), len(bg), len(prewarm), bad or "none"))


def cold_summary(mine):
    colds = [_ms(r) for r in mine
             if r.get("e") == "cold" and not r.get("prewarm") and not r.get("bg")]
    if not colds:
        return None
    return Result("cold launch time (no budget)", INFO,
                  "n=%d p50=%.0f ms p90=%.0f ms, background and prewarmed launches excluded"
                  % (len(colds), percentile(colds, 50), percentile(colds, 90)))


def check_windowed_p90(event, unit, scope, budget, window, min_samples):
    """p90 of the most recent `window` samples of `event`; WARN, not PASS, when there are too few."""
    samples = [r for r in scope if r.get("e") == event]
    recent = samples[-window:]
    name = "%s p90 <= %s %s" % (event, budget, unit)
    notes = version_notes(recent)
    if len(recent) < min_samples:
        return Result(name, WARN,
                      "NOT EVALUATED: %d sample(s) < %d needed (window: most recent %d, all versions pooled)"
                      % (len(recent), min_samples, window), notes)
    p90 = percentile([_ms(r) for r in recent], 90)
    return Result(name, PASS if p90 <= budget else FAIL,
                  "p90 %.1f %s over the %d most recent sample(s), all versions pooled (%d in file)"
                  % (p90, unit, len(recent), len(samples)), notes)


def check_stream_hangs(mine):
    """No main-thread hang >= 250 ms while the reply was streaming.

    Needs the `stream` flag LeoPerf writes on `hang` records (true when streaming text
    was flushed in the 2 s before the hang began); older records cannot be attributed.
    """
    name = "main-thread hangs >= %d ms while streaming == %d" % (STREAM_HANG_MIN_MS, BUDGET_STREAM_HANGS)
    hangs = [r for r in mine if r.get("e") == "hang"]
    tagged = [h for h in hangs if "stream" in h]
    untagged = [h for h in hangs if "stream" not in h]
    sends = [r for r in mine if r.get("e") in ("send.firstToken", "mac.firstToken")]
    streaming = [_ms(h) for h in tagged if h["stream"] and _ms(h) >= STREAM_HANG_MIN_MS]
    if len(streaming) > BUDGET_STREAM_HANGS:
        return Result(name, FAIL, "%d hang(s) during streaming: %s ms (%d tagged hang(s), %d send(s) observed)"
                      % (len(streaming), sorted(streaming, reverse=True), len(tagged), len(sends)))
    if untagged:
        return Result(name, WARN,
                      "NOT EVALUATED for %d hang(s): the record has no `stream` flag (written by a build that "
                      "predates it), so streaming cannot be told apart; %d tagged hang(s) were outside streaming"
                      % (len(untagged), len(tagged)))
    if not sends:
        return Result(name, WARN, "NOT EVALUATED: no send.firstToken / mac.firstToken for this version, "
                                  "streaming was not exercised")
    return Result(name, PASS, "0 hang(s) during streaming (%d tagged hang(s) elsewhere, %d send(s) observed)"
                  % (len(tagged), len(sends)))


def check_perf(records, version=None):
    explicit = version is not None
    ordered = sorted(records, key=_t)
    if version is None:
        version = next((r.get("v") for r in reversed(ordered) if r.get("v")), None)
    mine = [r for r in ordered if r.get("v") == version]
    # fg.frame / scroll.hitch pool recent samples across builds (a single build rarely
    # has enough); an explicit --version pins them to that build.
    pooled = mine if explicit else ordered

    results = [check_launch_hangs(mine, version)]
    summary = cold_summary(mine)
    if summary:
        results.append(summary)
    results.append(check_windowed_p90("fg.frame", "ms", pooled, BUDGET_FG_FRAME_P90_MS,
                                      FG_FRAME_WINDOW, FG_FRAME_MIN_SAMPLES))
    results.append(check_windowed_p90("scroll.hitch", "ms/s", pooled, BUDGET_SCROLL_HITCH_P90,
                                      SCROLL_HITCH_WINDOW, SCROLL_HITCH_MIN_SAMPLES))
    results.append(check_stream_hangs(mine))
    return version, results


def summarize(results):
    failed = [r for r in results if r.status == FAIL]
    unevaluated = [r for r in results if r.status == WARN]
    if failed:
        return "RESULT: FAIL (%d budget(s) failed)" % len(failed), 1
    if unevaluated:
        return ("RESULT: PASS WITH WARNINGS - nothing failed, but %d budget(s) were NOT evaluated "
                "(this is not a pass): %s" % (len(unevaluated), "; ".join(r.name for r in unevaluated))), 0
    return "RESULT: PASS", 0


def run(perf_path, log_path, version=None, out=sys.stdout):
    with open(log_path, encoding="utf-8", errors="replace") as f:
        log_lines = f.read().splitlines()
    with open(perf_path, encoding="utf-8", errors="replace") as f:
        perf_records = load_perf(f.read().splitlines())
    version, perf_results = check_perf(perf_records, version)
    results = check_log(log_lines) + perf_results
    print("IOSPerfBudgetGate (version %s)" % (version or "?"), file=out)
    for r in results:
        print("  [%s] %s — %s" % (r.status, r.name, r.detail), file=out)
        for note in r.notes:
            print("         %s" % note, file=out)
    line, code = summarize(results)
    print(line, file=out)
    return code


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--perf", required=True)
    parser.add_argument("--log", required=True)
    parser.add_argument("--version")
    args = parser.parse_args(argv)
    return run(args.perf, args.log, args.version)


if __name__ == "__main__":
    sys.exit(main())
