#!/usr/bin/env python3
"""Unit tests for IOSPerfBudgetGate.py against the fixtures in fixtures/perf-budget/."""
import io
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import IOSPerfBudgetGate as gate  # noqa: E402

FIX = HERE / "fixtures" / "perf-budget"


def run(case):
    out = io.StringIO()
    code = gate.run(str(FIX / case / "perf.jsonl"), str(FIX / case / "day.log"), out=out)
    return code, out.getvalue()


class PerfBudgetGateTests(unittest.TestCase):
    def test_clean_run_passes_and_ignores_older_launches(self):
        code, text = run("pass")
        self.assertEqual(code, 0, text)
        self.assertIn("version 1.61.0", text)
        self.assertIn("busiest second has 70 lines", text)
        self.assertIn("3 lines in the first 10 s", text)

    def test_every_budget_violation_is_reported(self):
        code, text = run("fail")
        self.assertEqual(code, 1, text)
        for name in ("launch-second log lines", "FPWatcher lines", "hang >= 500 ms",
                     "TextContainerGuard lines", "fg.frame p90"):
            self.assertRegex(text, r"\[FAIL\] [^\n]*" + name.replace("+", r"\+"))

    def test_missing_launch_marker_fails(self):
        results = gate.check_log(["[10:00:00] [Boot] [INFO] no marker"])
        self.assertFalse(results[0][1])

    def test_fg_frame_needs_five_samples(self):
        recs = [{"t": i, "e": "fg.frame", "ms": 2000, "v": "x"} for i in range(4)]
        _, results = gate.check_perf(recs)
        frame = [r for r in results if "fg.frame" in r[0]][0]
        self.assertTrue(frame[1])
        self.assertIn("skipped", frame[2])

    def test_percentile_nearest_rank(self):
        self.assertEqual(gate.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9)
        self.assertEqual(gate.percentile([5], 90), 5)

    def test_midnight_wrap_keeps_order(self):
        seg = gate.last_launch_segment([
            "[23:59:59] [Lifecycle] [INFO] process launch pid=1",
            "[00:00:00] [Boot] [INFO] a",
        ])
        self.assertEqual(seg[1][0] - seg[0][0], 1)


if __name__ == "__main__":
    unittest.main()
