#!/usr/bin/env python3
"""Unit tests for IOSPerfBudgetGate.py.

Whole-run behaviour is checked against the fixtures in fixtures/perf-budget/
(pass / fail / warn / older-noisy); each rule's edge cases against small synthetic
day logs and perf records built here. No real device data is used.
"""
import io
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import IOSPerfBudgetGate as gate  # noqa: E402

FIX = HERE / "fixtures" / "perf-budget"


def run(case, version=None):
    out = io.StringIO()
    code = gate.run(str(FIX / case / "perf.jsonl"), str(FIX / case / "day.txt"), version=version, out=out)
    return code, out.getvalue()


def day_log(*busiest):
    """A day log with one launch per argument; launch N has `busiest[N]` lines in its busiest second."""
    lines = []
    for i, n in enumerate(busiest):
        lines.append("[%02d:00:00] [Lifecycle] [INFO] process launch pid=%d" % (8 + i, i))
        lines += ["[%02d:00:01] [App] [INFO] line %d" % (8 + i, k) for k in range(n)]
    return lines


def rec(e, t, ms=0, v="1.61.0", **extra):
    record = {"e": e, "t": t, "ms": ms, "v": v}
    record.update(extra)
    return record


def cold(end_t, ms=650, v="1.61.0", **extra):
    """A cold launch that finished at `end_t`; it started at end_t - ms/1000."""
    return rec("cold", end_t, ms=ms, v=v, end="homeReady", **extra)


def frames(n, ms, v="1.61.0", t0=1760000100.0):
    return [rec("fg.frame", t0 + i, ms=ms, v=v) for i in range(n)]


def hitches(values, v="1.61.0", t0=1760000200.0):
    return [rec("scroll.hitch", t0 + i, ms=ms, v=v) for i, ms in enumerate(values)]


def named(results, fragment):
    matches = [r for r in results if fragment in r.name]
    assert len(matches) == 1, "expected one result matching %r, got %s" % (fragment, [r.name for r in matches])
    return matches[0]


class FixtureRunTests(unittest.TestCase):
    def test_clean_run_passes_with_no_warnings(self):
        code, text = run("pass")
        self.assertEqual(code, 0, text)
        self.assertIn("version 1.61.0", text)
        self.assertIn("median busiest second over 2 launch(es) is 55 lines", text)
        self.assertIn("worst of the last 2 launch(es) has 70 lines", text)
        self.assertIn("3 lines in the first 10 s", text)
        self.assertNotIn("[WARN]", text)
        self.assertNotIn("[FAIL]", text)
        self.assertIn("\nRESULT: PASS\n", text)

    def test_every_budget_violation_is_reported(self):
        code, text = run("fail")
        self.assertEqual(code, 1, text)
        for name in ("launch-second log lines p50", "FPWatcher lines", "hang >= 500 ms",
                     "TextContainerGuard lines", "fg.frame p90", "scroll.hitch p90",
                     "while streaming"):
            self.assertRegex(text, r"\[FAIL\] [^\n]*" + name.replace("+", r"\+"))
        self.assertIn("RESULT: FAIL", text)

    def test_older_noisy_launch_is_no_longer_ignored(self):
        # The old gate looked only at the last launch (70 lines) and passed this run; the
        # earlier launch had 300 lines in one second.
        code, text = run("older-noisy")
        self.assertEqual(code, 1, text)
        self.assertRegex(text, r"\[FAIL\] launch-second log lines max\(last 10\)[^\n]*300 lines")
        self.assertIn("oldest to newest: 300, 70", text)

    def test_unevaluable_budgets_warn_and_the_run_is_not_called_a_pass(self):
        code, text = run("warn")
        self.assertEqual(code, 0, text)
        self.assertEqual(text.count("[WARN]"), 3, text)
        for name in ("fg.frame p90", "scroll.hitch p90", "while streaming"):
            self.assertRegex(text, r"\[WARN\] [^\n]*" + name + r"[^\n]*NOT EVALUATED")
        self.assertIn("PASS WITH WARNINGS", text)
        self.assertIn("this is not a pass", text)
        self.assertNotIn("\nRESULT: PASS\n", text)

    def test_explicit_version_pins_the_pooled_budgets(self):
        code, text = run("pass", version="1.60.0")
        self.assertEqual(code, 0, text)
        self.assertIn("version 1.60.0", text)
        self.assertIn("over the 5 most recent sample(s)", text)       # fg.frame: only 1.60.0's five
        self.assertRegex(text, r"\[WARN\] scroll.hitch")               # 1.60.0 has no scroll data
        self.assertNotIn("1.61.0: n=", text)

    def test_cli_exit_codes(self):
        self.assertEqual(gate.main(["--perf", str(FIX / "pass" / "perf.jsonl"), "--log", str(FIX / "pass" / "day.txt")]), 0)
        self.assertEqual(gate.main(["--perf", str(FIX / "fail" / "perf.jsonl"), "--log", str(FIX / "fail" / "day.txt")]), 1)


class LaunchLogTests(unittest.TestCase):
    def test_missing_launch_marker_fails(self):
        results = gate.check_log(["[10:00:00] [Boot] [INFO] no marker"])
        self.assertEqual(results[0].status, gate.FAIL)

    def test_median_launch_is_budgeted(self):
        results = gate.check_log(day_log(90, 95, 85, 40))     # sorted 40 85 90 95 → nearest-rank p50 = 85
        self.assertEqual(named(results, "p50").status, gate.FAIL)
        self.assertEqual(named(results, "max(last").status, gate.PASS)

    def test_worst_recent_launch_is_budgeted_even_when_the_last_launch_is_quiet(self):
        results = gate.check_log(day_log(200, 60, 50))
        self.assertEqual(named(results, "p50").status, gate.PASS)
        self.assertEqual(named(results, "max(last").status, gate.FAIL)
        self.assertIn("oldest to newest: 200, 60, 50", named(results, "max(last").detail)

    def test_only_the_most_recent_launches_count_for_the_max(self):
        results = gate.check_log(day_log(400, *([60] * gate.LAUNCH_RECENT_N)))
        self.assertEqual(named(results, "max(last").status, gate.PASS, "the 400-line launch is older than the window")
        self.assertEqual(named(results, "p50").status, gate.PASS)
        self.assertIn("over %d launch(es)" % (gate.LAUNCH_RECENT_N + 1), named(results, "p50").detail)

    def test_budget_boundaries_are_inclusive(self):
        ok = gate.check_log(day_log(gate.BUDGET_LAUNCH_SECOND_LINES_P50))
        self.assertEqual(named(ok, "p50").status, gate.PASS)
        over = gate.check_log(day_log(gate.BUDGET_LAUNCH_SECOND_LINES_MAX + 1, 10, 10))
        self.assertEqual(named(over, "max(last").status, gate.FAIL)

    def test_busiest_second_only_looks_at_the_first_three_seconds(self):
        lines = ["[09:00:00] [Lifecycle] [INFO] process launch"]
        lines += ["[09:00:01] [App] [INFO] a"] * 5
        lines += ["[09:00:03] [App] [INFO] late"] * 500          # fourth second: outside the window
        segment = gate.launch_segments(lines)[0]
        self.assertEqual(gate.busiest_second(segment), 5)

    def test_fpwatcher_and_guard_budgets_describe_the_last_launch_only(self):
        lines = day_log(30, 30)
        lines.insert(1, "[08:00:02] [FPWatcher] [WARN] old")        # in the first launch's first 10 s
        lines.insert(1, "[08:00:02] [TextContainerGuard] [WARN] old loop")
        results = gate.check_log(lines)
        self.assertEqual(named(results, "FPWatcher").status, gate.PASS)
        self.assertEqual(named(results, "TextContainerGuard").status, gate.PASS)
        lines.append("[09:00:02] [TextContainerGuard] [WARN] new loop")
        self.assertEqual(named(gate.check_log(lines), "TextContainerGuard").status, gate.FAIL)

    def test_midnight_wrap_keeps_order(self):
        seg = gate.last_launch_segment([
            "[23:59:59] [Lifecycle] [INFO] process launch pid=1",
            "[00:00:00] [Boot] [INFO] a",
        ])
        self.assertEqual(seg[1][0] - seg[0][0], 1)

    def test_launches_either_side_of_midnight_are_both_found(self):
        segments = gate.launch_segments([
            "[23:59:58] [Lifecycle] [INFO] process launch pid=1",
            "[23:59:59] [Boot] [INFO] a",
            "[00:00:05] [Lifecycle] [INFO] process launch pid=2",
            "[00:00:06] [Boot] [INFO] b",
        ])
        self.assertEqual(len(segments), 2)
        self.assertGreater(segments[1][0][0], segments[0][-1][0])

    def test_percentile_nearest_rank(self):
        self.assertEqual(gate.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9)
        self.assertEqual(gate.percentile([5], 90), 5)
        self.assertEqual(gate.percentile([40, 85, 90, 95], 50), 85)
        self.assertIsNone(gate.percentile([], 50))


class ColdLaunchTests(unittest.TestCase):
    LAUNCH = 1760000000.0

    def hang_after(self, launch, offset_s, ms=900):
        """A hang that began `offset_s` after `launch` (records are written when the hang ends)."""
        return rec("hang", launch + offset_s + ms / 1000.0, ms=ms, stream=False)

    def test_background_cold_launch_is_not_counted_against_the_launch_budget(self):
        records = [
            cold(self.LAUNCH + 0.65, bg=False),
            rec("hang", self.LAUNCH + 1.2, ms=300, stream=False),
            cold(1760000600.0, ms=45000.0, bg=True),               # woken in the background 45 s earlier
            self.hang_after(1760000555.0, 1.0),                     # 900 ms, 1 s after THAT launch
        ]
        _, results = gate.check_perf(records)
        r = named(results, "within 3 s of launch")
        self.assertEqual(r.status, gate.PASS, r.detail)
        self.assertIn("excluded: 1 bg", r.detail)

    def test_the_same_hang_fails_when_the_launch_is_not_marked_background(self):
        records = [cold(self.LAUNCH + 0.65), cold(1760000600.0, ms=45000.0), self.hang_after(1760000555.0, 1.0)]
        _, results = gate.check_perf(records)
        r = named(results, "within 3 s of launch")
        self.assertEqual(r.status, gate.FAIL, r.detail)
        self.assertIn("[900]", r.detail)

    def test_foreground_cold_launch_hang_is_reported(self):
        records = [cold(self.LAUNCH + 0.7, ms=700), self.hang_after(self.LAUNCH, 1.0, ms=667)]
        _, results = gate.check_perf(records)
        self.assertEqual(named(results, "within 3 s of launch").status, gate.FAIL)

    def test_prewarmed_launches_are_still_excluded(self):
        records = [cold(1760000600.0, ms=300000.0, prewarm=True), self.hang_after(1760000300.0, 1.0)]
        _, results = gate.check_perf(records)
        r = named(results, "within 3 s of launch")
        self.assertEqual(r.status, gate.WARN, "the only cold launch was a prewarm: nothing left to evaluate")
        self.assertIn("1 prewarm", r.detail)

    def test_no_foreground_cold_launch_warns_instead_of_passing(self):
        _, results = gate.check_perf([cold(1760000600.0, ms=45000.0, bg=True)])
        r = named(results, "within 3 s of launch")
        self.assertEqual(r.status, gate.WARN)
        self.assertIn("NOT EVALUATED", r.detail)
        self.assertIn("1 bg", r.detail)

    def test_older_builds_do_not_count(self):
        records = [
            cold(1759996402.0, ms=2000, v="1.60.0"), self.hang_after(1759996400.0, 1.0),
            cold(self.LAUNCH + 0.65, v="1.61.0"),
        ]
        version, results = gate.check_perf(records)
        self.assertEqual(version, "1.61.0")
        self.assertEqual(named(results, "within 3 s of launch").status, gate.PASS)

    def test_cold_summary_excludes_bg_and_prewarm(self):
        records = [cold(1.0e9 + 1, ms=600), cold(1.0e9 + 2, ms=800), cold(1.0e9 + 3, ms=90000.0, bg=True),
                   cold(1.0e9 + 4, ms=900000.0, prewarm=True)]
        _, results = gate.check_perf(records)
        info = named(results, "cold launch time")
        self.assertEqual(info.status, gate.INFO)
        self.assertIn("n=2", info.detail)

    def test_records_from_older_builds_without_new_fields_still_work(self):
        records = [rec("cold", self.LAUNCH + 0.65, ms=650, end="homeReady", prewarm=False)]   # no `bg`
        _, results = gate.check_perf(records)
        self.assertEqual(named(results, "within 3 s of launch").status, gate.PASS)


class WindowedPercentileTests(unittest.TestCase):
    def test_fg_frame_with_fewer_than_five_samples_warns_not_passes(self):
        _, results = gate.check_perf([rec("fg.frame", i, ms=2000, v="x") for i in range(4)])
        r = named(results, "fg.frame")
        self.assertEqual(r.status, gate.WARN)
        self.assertIn("NOT EVALUATED", r.detail)
        self.assertIn("4 sample(s) < 5", r.detail)

    def test_fg_frame_is_evaluated_from_five_samples(self):
        _, results = gate.check_perf(frames(5, 2000))
        self.assertEqual(named(results, "fg.frame").status, gate.FAIL)
        _, results = gate.check_perf(frames(5, 100))
        self.assertEqual(named(results, "fg.frame").status, gate.PASS)

    def test_fg_frame_pools_the_most_recent_thirty_across_versions(self):
        old = frames(40, 2000, v="1.60.0", t0=1759990000.0)
        new = frames(30, 100, v="1.61.0")
        _, results = gate.check_perf(old + new)
        r = named(results, "fg.frame")
        self.assertEqual(r.status, gate.PASS, "the 40 slow samples of the old build fall outside the window")
        self.assertIn("over the 30 most recent sample(s)", r.detail)
        self.assertEqual(r.notes, ["1.61.0: n=30 p50=100.0 p90=100.0"])

    def test_fg_frame_window_that_straddles_builds_fails_and_lists_each_build(self):
        old = frames(5, 2000, v="1.60.0", t0=1759990000.0)
        new = frames(25, 100, v="1.61.0")
        _, results = gate.check_perf(old + new)
        r = named(results, "fg.frame")
        self.assertEqual(r.status, gate.FAIL)       # 27th smallest of 30 is one of the five slow ones
        self.assertEqual(r.notes, ["1.61.0: n=25 p50=100.0 p90=100.0", "1.60.0: n=5 p50=2000.0 p90=2000.0"])

    def test_fg_frame_budget_boundary_is_inclusive(self):
        _, results = gate.check_perf(frames(5, gate.BUDGET_FG_FRAME_P90_MS))
        self.assertEqual(named(results, "fg.frame").status, gate.PASS)
        _, results = gate.check_perf(frames(5, gate.BUDGET_FG_FRAME_P90_MS + 1))
        self.assertEqual(named(results, "fg.frame").status, gate.FAIL)

    def test_samples_are_ordered_by_timestamp_not_file_order(self):
        newest_first = list(reversed(frames(30, 100, t0=1760000200.0))) + frames(10, 2000, t0=1760000000.0)
        _, results = gate.check_perf(newest_first)
        self.assertEqual(named(results, "fg.frame").status, gate.PASS)

    def test_scroll_hitch_needs_twenty_samples(self):
        _, results = gate.check_perf(hitches([50.0] * 19))
        r = named(results, "scroll.hitch")
        self.assertEqual(r.status, gate.WARN)
        self.assertIn("19 sample(s) < 20", r.detail)
        _, results = gate.check_perf(hitches([50.0] * 20))
        self.assertEqual(named(results, "scroll.hitch").status, gate.FAIL)

    def test_scroll_hitch_p90_boundary(self):
        # 20 samples: nearest-rank p90 is the 18th smallest.
        ok = [1.0] * 17 + [20.0, 99.0, 99.0]
        _, results = gate.check_perf(hitches(ok))
        self.assertEqual(named(results, "scroll.hitch").status, gate.PASS)
        over = [1.0] * 17 + [20.1, 99.0, 99.0]
        _, results = gate.check_perf(hitches(over))
        self.assertEqual(named(results, "scroll.hitch").status, gate.FAIL)

    def test_scroll_hitch_pools_builds_like_fg_frame(self):
        records = hitches([5.0] * 12, v="1.60.0", t0=1759990000.0) + hitches([6.0] * 12, v="1.61.0")
        _, results = gate.check_perf(records)
        r = named(results, "scroll.hitch")
        self.assertEqual(r.status, gate.PASS, "12 + 12 samples are enough only when pooled")
        self.assertEqual(len(r.notes), 2)


class StreamingHangTests(unittest.TestCase):
    SENDS = [rec("send.firstToken", 1760000050.0, ms=800)]

    def test_hang_during_streaming_fails(self):
        records = self.SENDS + [rec("hang", 1760000060.0, ms=400, stream=True)]
        _, results = gate.check_perf(records)
        r = named(results, "while streaming")
        self.assertEqual(r.status, gate.FAIL)
        self.assertIn("[400]", r.detail)

    def test_hang_outside_streaming_passes(self):
        records = self.SENDS + [rec("hang", 1760000060.0, ms=400, stream=False)]
        _, results = gate.check_perf(records)
        r = named(results, "while streaming")
        self.assertEqual(r.status, gate.PASS)
        self.assertIn("1 tagged hang(s) elsewhere", r.detail)

    def test_no_hangs_and_sends_observed_passes(self):
        _, results = gate.check_perf(self.SENDS)
        self.assertEqual(named(results, "while streaming").status, gate.PASS)

    def test_hangs_without_the_stream_flag_cannot_be_attributed(self):
        records = self.SENDS + [rec("hang", 1760000060.0, ms=400)]
        _, results = gate.check_perf(records)
        r = named(results, "while streaming")
        self.assertEqual(r.status, gate.WARN)
        self.assertIn("no `stream` flag", r.detail)

    def test_streaming_not_exercised_warns(self):
        _, results = gate.check_perf([cold(1760000000.65)])
        r = named(results, "while streaming")
        self.assertEqual(r.status, gate.WARN)
        self.assertIn("not exercised", r.detail)

    def test_a_proven_streaming_hang_fails_even_if_other_hangs_are_untagged(self):
        records = self.SENDS + [rec("hang", 1760000060.0, ms=400), rec("hang", 1760000070.0, ms=500, stream=True)]
        _, results = gate.check_perf(records)
        self.assertEqual(named(results, "while streaming").status, gate.FAIL)

    def test_mac_relay_sends_count_as_streaming_activity(self):
        _, results = gate.check_perf([rec("mac.firstToken", 1760000050.0, ms=900)])
        self.assertEqual(named(results, "while streaming").status, gate.PASS)

    def test_other_builds_hangs_do_not_count(self):
        records = self.SENDS + [rec("hang", 1759990000.0, ms=900, v="1.60.0", stream=True)]
        _, results = gate.check_perf(records)
        self.assertEqual(named(results, "while streaming").status, gate.PASS)


class SummaryTests(unittest.TestCase):
    def test_summary_and_exit_code(self):
        p = gate.Result("a", gate.PASS, "")
        w = gate.Result("b", gate.WARN, "")
        f = gate.Result("c", gate.FAIL, "")
        i = gate.Result("d", gate.INFO, "")
        self.assertEqual(gate.summarize([p, i]), ("RESULT: PASS", 0))
        line, code = gate.summarize([p, w, i])
        self.assertEqual(code, 0)
        self.assertTrue(line.startswith("RESULT: PASS WITH WARNINGS"))
        self.assertIn("b", line)
        self.assertEqual(gate.summarize([p, w, f])[1], 1)
        self.assertTrue(gate.summarize([p, w, f])[0].startswith("RESULT: FAIL"))

    def test_malformed_perf_lines_are_skipped(self):
        records = gate.load_perf(['{"e": "hang", "t": 1}', "not json", "", "[1, 2]", '{"e": "cold"'])
        self.assertEqual(records, [{"e": "hang", "t": 1}])


if __name__ == "__main__":
    unittest.main()
