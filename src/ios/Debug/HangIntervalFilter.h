//
//  HangIntervalFilter.h
//
//  Pure helpers for HangDetector (header-only so the logic-test target can
//  exercise them without the detector's mach / runloop machinery).
//
//  The monitor thread measures "main busy" as now - lastRunloopBeat on
//  mach_continuous_time. When the process is suspended (background, screen
//  locked) or the device sleeps, the monitor thread stops too; on resume it
//  can read a beat from before the suspension and report the whole
//  suspension as a main-thread hang (observed: 491 700 ms "MAIN HANG" with an
//  AfterWaiting beat from before an 8-minute background stay). Such
//  intervals are excluded by moving a floor past them.
//

#ifndef HangIntervalFilter_h
#define HangIntervalFilter_h

#include <stdbool.h>

/// Extra poll-to-poll time beyond the poll interval that only a suspended
/// (descheduled) monitor thread produces.
static const double kLeoHangSuspendSlackMs = 1000.0;
/// Growth of (mach_continuous_time - mach_absolute_time) that means the
/// device slept between two polls (absolute time stops during sleep).
static const double kLeoHangSleepSlackMs = 50.0;

/// True when the interval since the previous poll must not count as main
/// thread work: the monitor itself was not running (process suspended) or
/// the device slept.
static inline bool LeoHangIsSuspensionGap(double pollGapMs, double pollIntervalMs, double sleepDeltaMs) {
    if (sleepDeltaMs > kLeoHangSleepSlackMs) return true;
    return pollGapMs > pollIntervalMs + kLeoHangSuspendSlackMs;
}

/// Main-thread busy time, counted from the later of the last runloop beat
/// and the floor (last resume / foreground / background poll).
static inline double LeoHangEffectiveBusyMs(double nowMs, double lastBeatMs, double floorMs) {
    double start = lastBeatMs > floorMs ? lastBeatMs : floorMs;
    return nowMs > start ? nowMs - start : 0.0;
}

#endif /* HangIntervalFilter_h */
