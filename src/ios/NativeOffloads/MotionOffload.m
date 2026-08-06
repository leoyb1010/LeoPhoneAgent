//
//  MotionOffload.m
//  MinisApp
//
//  Native offload handler for `apple-motion`.
//  Subcommands: steps, activity, status
//
//  规格书 B·P1「步数、活动、传感器」:补 HealthKit 的实时短板——HealthKit
//  的步数是异步归档的(常滞后几分钟到几小时),CMPedometer 直接读协处理器,
//  「今天到现在走了多少步」才是准的。活动识别(walking/running/automotive)
//  HealthKit 根本没有。系统只保留最近 7 天,更早的历史仍走 apple-healthkit。
//

#import <Foundation/Foundation.h>
#import <CoreMotion/CoreMotion.h>
#import "NativeOffloadUtils.h"
#include "kernel/native_offload.h"

static NSString *const TOOL_NAME = @"apple-motion";

static NSString *const HELP_TEXT =
    @"apple-motion - Pedometer and motion activity from CoreMotion\n"
     "\n"
     "USAGE:\n"
     "  apple-motion <command> [options]\n"
     "\n"
     "COMMANDS:\n"
     "  steps      Step counts from the motion coprocessor (default)\n"
     "  activity   Motion activity segments (walking/running/driving/...)\n"
     "  status     Authorization and hardware availability\n"
     "\n"
     "COMMON OPTIONS:\n"
     "  --help, -h           Show this help message\n"
     "  --compact            Minimize JSON output\n"
     "  -q, --quiet          Output only data field\n"
     "\n"
     "STEPS / ACTIVITY OPTIONS:\n"
     "  --days <N>           How many days back, 1-7 (default 1 = today).\n"
     "                       iOS only keeps 7 days of coprocessor history;\n"
     "                       older data lives in apple-healthkit.\n"
     "\n"
     "ACTIVITY OPTIONS:\n"
     "  --limit <N>          Max segments in output (default 50, newest kept)\n"
     "\n"
     "EXAMPLES:\n"
     "  apple-motion steps\n"
     "  apple-motion steps --days 7\n"
     "  apple-motion activity --days 2 --limit 20\n"
     "  apple-motion status\n";

// ── Authorization ──

static NSString *auth_status_name(void) {
    switch ([CMPedometer authorizationStatus]) {
        case CMAuthorizationStatusNotDetermined: return @"not_determined";
        case CMAuthorizationStatusRestricted:    return @"restricted";
        case CMAuthorizationStatusDenied:        return @"denied";
        case CMAuthorizationStatusAuthorized:    return @"authorized";
    }
    return @"unknown";
}

/// Returns an error envelope if motion access is denied/restricted, else nil.
/// notDetermined passes through — the first query triggers the system prompt.
static NSDictionary *check_denied(NSString *action) {
    CMAuthorizationStatus status = [CMPedometer authorizationStatus];
    if (status == CMAuthorizationStatusDenied || status == CMAuthorizationStatusRestricted) {
        return noff_json_error(TOOL_NAME, action, NOFF_ERR_AUTHORIZATION_DENIED,
                               @"Motion & Fitness access is denied. Enable it in "
                                "设置 → 隐私与安全性 → 运动与健身 → LeoPhoneAgent.");
    }
    return nil;
}

// ── steps ──

static NSInteger parse_days(int argc, char **argv) {
    NSString *daysArg = noff_find_arg(argc, argv, "--days");
    NSInteger days = daysArg ? daysArg.integerValue : 1;
    return MAX(1, MIN(days, 7));
}

static int cmd_steps(int argc, char **argv, int stdout_fd, BOOL compact, BOOL quiet) {
    NSDictionary *denied = check_denied(@"steps");
    if (denied) {
        noff_emit_json(stdout_fd, denied, compact, quiet);
        return NOFF_EXIT_AUTH_DENIED;
    }
    if (![CMPedometer isStepCountingAvailable]) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"steps", NOFF_ERR_NOT_AVAILABLE,
                       @"Step counting is not available on this device"), compact, quiet);
        return NOFF_EXIT_NOT_AVAILABLE;
    }

    NSInteger days = parse_days(argc, argv);
    NSCalendar *calendar = [NSCalendar currentCalendar];
    NSDate *now = [NSDate date];

    CMPedometer *pedometer = [[CMPedometer alloc] init];
    NSMutableArray *dayRows = [NSMutableArray array];
    __block NSError *queryError = nil;
    double totalSteps = 0, totalDistance = 0;

    // Per-day windows, oldest first. Serial queries: the pedometer callback
    // queue is serial anyway and 7 sequential reads finish in well under 1s.
    for (NSInteger i = days - 1; i >= 0; i--) {
        NSDate *dayStart = [calendar startOfDayForDate:
                            [calendar dateByAddingUnit:NSCalendarUnitDay value:-i toDate:now options:0]];
        NSDate *dayEnd = (i == 0) ? now
            : [calendar dateByAddingUnit:NSCalendarUnitDay value:1 toDate:dayStart options:0];

        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        __block CMPedometerData *dayData = nil;
        [pedometer queryPedometerDataFromDate:dayStart toDate:dayEnd
                                  withHandler:^(CMPedometerData *pedometerData, NSError *error) {
            dayData = pedometerData;
            if (error) queryError = error;
            dispatch_semaphore_signal(sem);
        }];
        dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));
        if (noff_is_cancelled()) return NOFF_EXIT_ERROR;
        if (!dayData) break;

        NSMutableDictionary *row = [NSMutableDictionary dictionary];
        row[@"date"] = ({
            NSDateFormatter *df = [[NSDateFormatter alloc] init];
            df.dateFormat = @"yyyy-MM-dd";
            [df stringFromDate:dayStart];
        });
        row[@"steps"] = dayData.numberOfSteps ?: @0;
        totalSteps += dayData.numberOfSteps.doubleValue;
        if (dayData.distance) {
            row[@"distance_m"] = @(round(dayData.distance.doubleValue));
            totalDistance += dayData.distance.doubleValue;
        }
        if (dayData.floorsAscended) row[@"floors_up"] = dayData.floorsAscended;
        if (dayData.floorsDescended) row[@"floors_down"] = dayData.floorsDescended;
        if (dayData.averageActivePace && dayData.averageActivePace.doubleValue > 0) {
            row[@"avg_pace_s_per_m"] = dayData.averageActivePace;
        }
        [dayRows addObject:row];
    }

    if (dayRows.count == 0) {
        // 授权弹窗被拒或查询失败:错误优先按拒绝解释(CoreMotion 的拒绝
        // 错误码是 CMErrorMotionActivityNotAuthorized=105)。
        BOOL deniedNow = [CMPedometer authorizationStatus] == CMAuthorizationStatusDenied;
        NSString *code = deniedNow ? NOFF_ERR_AUTHORIZATION_DENIED : NOFF_ERR_NO_DATA;
        NSString *msg = queryError.localizedDescription
            ?: (deniedNow ? @"Motion & Fitness access was denied."
                          : @"Pedometer query returned no data");
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"steps", code, msg), compact, quiet);
        return deniedNow ? NOFF_EXIT_AUTH_DENIED : NOFF_EXIT_ERROR;
    }

    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"steps", @{
        @"days": dayRows,
        @"total_steps": @((long)totalSteps),
        @"total_distance_m": @(round(totalDistance)),
        @"source": @"CMPedometer (live coprocessor; more current than HealthKit)",
    }), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

// ── activity ──

static NSString *activity_name(CMMotionActivity *a) {
    // 一个样本可能同时置多个位;按显著性挑一个主类型。
    if (a.automotive) return @"automotive";
    if (a.cycling)    return @"cycling";
    if (a.running)    return @"running";
    if (a.walking)    return @"walking";
    if (a.stationary) return @"stationary";
    return @"unknown";
}

static int cmd_activity(int argc, char **argv, int stdout_fd, BOOL compact, BOOL quiet) {
    NSDictionary *denied = check_denied(@"activity");
    if (denied) {
        noff_emit_json(stdout_fd, denied, compact, quiet);
        return NOFF_EXIT_AUTH_DENIED;
    }
    if (![CMMotionActivityManager isActivityAvailable]) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"activity", NOFF_ERR_NOT_AVAILABLE,
                       @"Motion activity is not available on this device"), compact, quiet);
        return NOFF_EXIT_NOT_AVAILABLE;
    }

    NSInteger days = parse_days(argc, argv);
    NSString *limitArg = noff_find_arg(argc, argv, "--limit");
    NSUInteger limit = limitArg ? MAX(1, limitArg.integerValue) : 50;

    NSCalendar *calendar = [NSCalendar currentCalendar];
    NSDate *now = [NSDate date];
    NSDate *start = [calendar startOfDayForDate:
                     [calendar dateByAddingUnit:NSCalendarUnitDay value:-(days - 1) toDate:now options:0]];

    CMMotionActivityManager *manager = [[CMMotionActivityManager alloc] init];
    NSOperationQueue *queue = [[NSOperationQueue alloc] init];
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block NSArray<CMMotionActivity *> *activities = nil;
    __block NSError *queryError = nil;

    [manager queryActivityStartingFromDate:start toDate:now toQueue:queue
                               withHandler:^(NSArray<CMMotionActivity *> *result, NSError *error) {
        activities = result;
        queryError = error;
        dispatch_semaphore_signal(sem);
    }];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC));

    if (!activities) {
        BOOL deniedNow = [CMPedometer authorizationStatus] == CMAuthorizationStatusDenied;
        NSString *code = deniedNow ? NOFF_ERR_AUTHORIZATION_DENIED : NOFF_ERR_NO_DATA;
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"activity", code,
                       queryError.localizedDescription ?: @"Activity query returned no data"), compact, quiet);
        return deniedNow ? NOFF_EXIT_AUTH_DENIED : NOFF_EXIT_ERROR;
    }

    // 合并相邻同类样本成段;顺带累计每类总时长。
    NSMutableArray *segments = [NSMutableArray array];
    NSMutableDictionary<NSString *, NSNumber *> *totals = [NSMutableDictionary dictionary];
    NSString *currentType = nil;
    NSDate *segmentStart = nil;
    NSDate *previousDate = nil;

    void (^closeSegment)(NSDate *) = ^(NSDate *end) {
        if (!currentType || !segmentStart) return;
        NSTimeInterval duration = [end timeIntervalSinceDate:segmentStart];
        if (duration < 1) return;
        [segments addObject:@{
            @"activity": currentType,
            @"start": noff_format_date(segmentStart),
            @"end": noff_format_date(end),
            @"duration_s": @((long)duration),
        }];
        totals[currentType] = @((totals[currentType].doubleValue) + duration);
    };

    for (CMMotionActivity *a in activities) {
        NSString *type = activity_name(a);
        if (![type isEqualToString:currentType]) {
            closeSegment(a.startDate);
            currentType = type;
            segmentStart = a.startDate;
        }
        previousDate = a.startDate;
    }
    // 最后一段延伸到现在(样本流是"状态从此刻开始"语义)。
    (void)previousDate;
    closeSegment(now);

    NSArray *limited = segments;
    if (segments.count > limit) {
        limited = [segments subarrayWithRange:NSMakeRange(segments.count - limit, limit)];
    }

    NSMutableDictionary *totalsRounded = [NSMutableDictionary dictionary];
    for (NSString *key in totals) totalsRounded[key] = @((long)totals[key].doubleValue);

    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"activity", @{
        @"segments": limited,
        @"segment_count": @(segments.count),
        @"truncated": @(segments.count > limit),
        @"totals_s": totalsRounded,
    }), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

// ── status ──

static int cmd_status(int stdout_fd, BOOL compact, BOOL quiet) {
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"status", @{
        @"authorization": auth_status_name(),
        @"step_counting_available": @([CMPedometer isStepCountingAvailable]),
        @"distance_available": @([CMPedometer isDistanceAvailable]),
        @"floor_counting_available": @([CMPedometer isFloorCountingAvailable]),
        @"pace_available": @([CMPedometer isPaceAvailable]),
        @"activity_available": @([CMMotionActivityManager isActivityAvailable]),
        @"history_window": @"7 days (coprocessor limit); use apple-healthkit for older data",
    }), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static int motion_handler(int argc, char **argv,
                          int stdin_fd, int stdout_fd, int stderr_fd) {
    if (noff_has_flag(argc, argv, "--help") || noff_has_flag(argc, argv, "-h")) {
        noff_emit_help(stderr_fd, HELP_TEXT);
        return NOFF_EXIT_SUCCESS;
    }
    BOOL compact = noff_has_flag(argc, argv, "--compact");
    BOOL quiet = noff_has_flag(argc, argv, "-q") || noff_has_flag(argc, argv, "--quiet");

    NSString *subcmd = noff_get_subcommand(argc, argv) ?: @"steps";

    @autoreleasepool {
        if ([subcmd isEqualToString:@"steps"])    return cmd_steps(argc, argv, stdout_fd, compact, quiet);
        if ([subcmd isEqualToString:@"activity"]) return cmd_activity(argc, argv, stdout_fd, compact, quiet);
        if ([subcmd isEqualToString:@"status"])   return cmd_status(stdout_fd, compact, quiet);
    }

    noff_emit_help(stderr_fd, HELP_TEXT);
    noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, subcmd, NOFF_ERR_INVALID_ARGS,
                   [NSString stringWithFormat:@"Unknown command '%@'. Valid: steps, activity, status.", subcmd]),
                   compact, quiet);
    return NOFF_EXIT_INVALID_ARGS;
}

void motion_offload_register(void) {
    int err = native_offload_add_handler("apple-motion", motion_handler);
    if (err == 0) {
        noff_ensure_guest_stub("/usr/local/bin/apple-motion");
        NSLog(@"NativeOffloads: apple-motion handler registered");
    } else {
        NSLog(@"NativeOffloads: failed to register apple-motion handler (err=%d)", err);
    }
}
