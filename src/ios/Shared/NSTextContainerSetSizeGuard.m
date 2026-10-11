//
//  NSTextContainerSetSizeGuard.m
//

#import "NSTextContainerSetSizeGuard.h"
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <objc/message.h>

// Associated-object key used to stash the per-container "last seen"
// state (last size + last tick + repeat count in this tick).
static const void *kGuardStateKey = &kGuardStateKey;

// Threshold: when the same container is asked to setSize: to the same
// value more than N times in a single runloop tick (after the first),
// short-circuit the rest. Picked to be > 1 so an initial legitimate
// duplicate (e.g. SwiftUI's two-axis probing) still flows through, but
// a reentrancy storm is broken.
static const NSInteger kRepeatThreshold = 2;

// Monotonic tick id, bumped from a runloop observer (BeforeWaiting).
// Two setSize: calls within the same tick share the same value here.
static uint64_t gRunloopTick = 0;

// Counter for analytics.
static uint64_t gShortCircuitCount = 0;

// setSize: calls that reached the original implementation (tests use the
// delta to prove a code path no longer issues a resize per layout pass).
static uint64_t gForwardedCount = 0;

// The "unbounded" dimension every larger value (.greatestFiniteMagnitude
// included) is clamped to. Swift mirrors it as
// `LeoTextContainer.unboundedHeight` (Views/Chat/ChatRenderLimits.swift);
// callers that restore an unbounded height compare against THAT value, never
// against .greatestFiniteMagnitude — after this clamp the stored height is
// always smaller than .greatestFiniteMagnitude, so such a comparison re-issues
// setSize: (and a full re-typeset) on every layout pass. [T-r3-S3]
static const CGFloat kLeoTextContainerUnbounded = 1e7;

// setSize: calls skipped because the container already had exactly that
// size. UIKit itself issues these: UITextView.sizeThatFits sets the container
// to (fitWidth, huge) and restores it afterwards — both identical to the
// current (width, 1e7) — and every such no-op still invalidated the whole
// layout (2 full re-typesets per measure, the device's repeatThisTick=6).
static uint64_t gIdenticalSkipCount = 0;

// [r7] Per-session summary instead of one line per short-circuit: counts by
// container width, logged once when the app leaves the foreground and only
// when something was actually short-circuited or rejected.
#define LEO_GUARD_WIDTH_BUCKETS 8
static CGFloat gBucketWidth[LEO_GUARD_WIDTH_BUCKETS];
static uint64_t gBucketCount[LEO_GUARD_WIDTH_BUCKETS];
static uint64_t gOtherWidthCount = 0;
static uint64_t gSessionShortCircuits = 0;
static uint64_t gSessionRejected = 0;
static uint64_t gSessionIdenticalSkips = 0;

static void LeoGuardRecordShortCircuit(CGFloat width) {
    gSessionShortCircuits += 1;
    CGFloat w = round(width);
    for (int i = 0; i < LEO_GUARD_WIDTH_BUCKETS; i++) {
        if (gBucketCount[i] == 0) { gBucketWidth[i] = w; gBucketCount[i] = 1; return; }
        if (gBucketWidth[i] == w) { gBucketCount[i] += 1; return; }
    }
    gOtherWidthCount += 1;
}

static NSString *LeoGuardSessionSummary(BOOL reset) {
    NSString *line = nil;
    if (gSessionShortCircuits > 0 || gSessionRejected > 0) {
        NSMutableString *widths = [NSMutableString string];
        for (int i = 0; i < LEO_GUARD_WIDTH_BUCKETS && gBucketCount[i] > 0; i++) {
            [widths appendFormat:@"%@%.0f:%llu", widths.length ? @"," : @"",
             gBucketWidth[i], (unsigned long long)gBucketCount[i]];
        }
        if (gOtherWidthCount > 0) {
            [widths appendFormat:@"%@other:%llu", widths.length ? @"," : @"", (unsigned long long)gOtherWidthCount];
        }
        line = [NSString stringWithFormat:
                @"[TextContainerGuard] [WARN] session summary shortCircuits=%llu rejected=%llu identicalSkipped=%llu byWidth={%@}",
                (unsigned long long)gSessionShortCircuits, (unsigned long long)gSessionRejected,
                (unsigned long long)gSessionIdenticalSkips, widths];
    }
    if (reset) {
        memset(gBucketWidth, 0, sizeof(gBucketWidth));
        memset(gBucketCount, 0, sizeof(gBucketCount));
        gOtherWidthCount = 0;
        gSessionShortCircuits = 0;
        gSessionRejected = 0;
        gSessionIdenticalSkips = 0;
    }
    return line;
}

typedef struct {
    CGSize lastSize;
    uint64_t lastTick;
    NSInteger repeatCount;
    BOOL initialized;
} GuardState;

@interface _NSTextContainerGuardState : NSObject {
@public
    GuardState state;
}
@end

@implementation _NSTextContainerGuardState
@end

static IMP gOriginalSetSize = NULL;

static void minis_NSTextContainer_setSize(id self, SEL _cmd, CGSize newSize) {
    if (![NSThread isMainThread]) {
        // Off-main calls (rare) bypass the guard entirely. Safer to
        // forward unconditionally than risk dropping a legit update.
        ((void (*)(id, SEL, CGSize))gOriginalSetSize)(self, _cmd, newSize);
        return;
    }

    // Sanitise obviously poisoned sizes that SwiftUI's measure path
    // occasionally leaks through (observed in LeoPhoneAgent-2026-05-22-225827.ips
    // ViewGraphGeometryObservers crash logs: `408 x 1.79e308` from
    // Double.greatestFiniteMagnitude, and `-16 x 0` from a ViewGraph
    // arithmetic underflow). NSTextContainer reacts to setSize: by
    // invalidating its layout manager's typeset and re-entering the
    // _fillLayoutHole storm; that re-entry runs concurrently with
    // SwiftUI's AsyncRenderer thread mutating ViewGraphGeometryObservers,
    // which is exactly the FB13213926 race.
    //
    // Two classes of input:
    //
    //  (1) Structurally bad — NaN / inf / negative. NSTextContainer can't
    //      represent these meaningfully; hard-reject before TextKit sees
    //      them. The original setSize: never runs, the reentrant
    //      _fillLayoutHole cascade never fires.
    //
    //  (2) Legitimate "unbounded container" — code calls
    //      `tc.size = CGSize(width: w, height: .greatestFiniteMagnitude)`
    //      on purpose to disable height clamping during typesetting (used
    //      throughout SelectableMarkdownView for the live + measure
    //      textViews). The previous version rejected these outright as
    //      "> 1e7", which silently dropped the width too — leading to
    //      typesetter measuring against a 0×0 container, a wrong height,
    //      and the rightmost characters of the last visual line getting
    //      clipped (T-truncated-last-line, observed via STF-trace dump).
    //      Clamp instead of reject: 1e7 is still ~30× the tallest real
    //      chat bubble (6000pt CALayer ceiling), so the typesetter
    //      treats it as unbounded just like .greatestFiniteMagnitude
    //      would. dedup below still collapses repeat probes within the
    //      same runloop tick, preserving the race-mitigation effect.
    if (!isfinite(newSize.width) || !isfinite(newSize.height) ||
        newSize.width < 0 || newSize.height < 0) {
        gShortCircuitCount += 1;
        gSessionRejected += 1;
        return;
    }
    if (newSize.width > kLeoTextContainerUnbounded) newSize.width = kLeoTextContainerUnbounded;
    if (newSize.height > kLeoTextContainerUnbounded) newSize.height = kLeoTextContainerUnbounded;

    // Only set when the value actually changes. Same size = same geometry, so
    // the layout stays valid (or is rebuilt lazily by the next ensureLayout);
    // forwarding would only invalidate it and force another full typeset.
    if (CGSizeEqualToSize(((NSTextContainer *)self).size, newSize)) {
        gIdenticalSkipCount += 1;
        gSessionIdenticalSkips += 1;
        return;
    }

    _NSTextContainerGuardState *holder = objc_getAssociatedObject(self, kGuardStateKey);
    if (!holder) {
        holder = [_NSTextContainerGuardState new];
        objc_setAssociatedObject(self, kGuardStateKey, holder, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }

    GuardState *s = &holder->state;

    if (s->initialized && s->lastTick == gRunloopTick &&
        CGSizeEqualToSize(s->lastSize, newSize)) {
        // Same tick, same container, same target size — increment and
        // short-circuit once we cross the threshold.
        s->repeatCount += 1;
        if (s->repeatCount >= kRepeatThreshold) {
            gShortCircuitCount += 1;
            // Counted per width; logged once per session (see summary).
            LeoGuardRecordShortCircuit(newSize.width);
            return; // skip forwarding to original setSize:
        }
    } else {
        // Different tick or different size — reset bookkeeping.
        s->lastSize = newSize;
        s->lastTick = gRunloopTick;
        s->repeatCount = 1;
        s->initialized = YES;
    }

    gForwardedCount += 1;
    ((void (*)(id, SEL, CGSize))gOriginalSetSize)(self, _cmd, newSize);
}

static void bumpRunloopTick(CFRunLoopObserverRef obs, CFRunLoopActivity act, void *info) {
    (void)obs; (void)act; (void)info;
    // Increment per runloop pass. We bump on BOTH BeforeWaiting and
    // AfterWaiting so a runloop pass that doesn't sleep (e.g. a busy
    // scene-update commit) still rotates the tick. Wrapping uint64
    // is fine for this purpose.
    gRunloopTick += 1;
}

@implementation NSTextContainerSetSizeGuard

+ (void)install {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        if (![NSThread isMainThread]) {
            NSLog(@"[TextContainerGuard] [WARN] install called off main; deferring");
            dispatch_async(dispatch_get_main_queue(), ^{ [NSTextContainerSetSizeGuard install]; });
            return;
        }

        Class cls = NSClassFromString(@"NSTextContainer");
        SEL sel = @selector(setSize:);
        Method m = class_getInstanceMethod(cls, sel);
        if (!m) {
            NSLog(@"[TextContainerGuard] [WARN] setSize: method not found on NSTextContainer");
            return;
        }
        gOriginalSetSize = method_setImplementation(m, (IMP)minis_NSTextContainer_setSize);

        // Runloop observer to rotate the tick id. Order 999_999 puts us
        // after typical layout observers; the exact value is not
        // critical because all we need is a monotonic-ish counter that
        // increases at least once per pass.
        CFRunLoopObserverRef obs = CFRunLoopObserverCreate(
            kCFAllocatorDefault,
            kCFRunLoopBeforeWaiting | kCFRunLoopAfterWaiting,
            true /* repeats */,
            999999 /* order */,
            bumpRunloopTick,
            NULL);
        if (obs) {
            CFRunLoopAddObserver(CFRunLoopGetMain(), obs, kCFRunLoopCommonModes);
            CFRelease(obs);
        }

        // One summary line per foreground session, nothing per call.
        for (NSNotificationName name in @[UIApplicationDidEnterBackgroundNotification,
                                          UIApplicationWillTerminateNotification]) {
            [[NSNotificationCenter defaultCenter] addObserverForName:name object:nil
                                                               queue:[NSOperationQueue mainQueue]
                                                          usingBlock:^(NSNotification *note) {
                (void)note;
                NSString *line = LeoGuardSessionSummary(YES);
                if (line) NSLog(@"%@", line);
            }];
        }
    });
}

+ (uint64_t)shortCircuitCount {
    return gShortCircuitCount;
}

+ (uint64_t)forwardedCount {
    return gForwardedCount;
}

+ (CGFloat)unboundedDimension {
    return kLeoTextContainerUnbounded;
}

+ (uint64_t)identicalSkipCount {
    return gIdenticalSkipCount;
}

+ (void)recordShortCircuitForTestingWidth:(CGFloat)width {
    LeoGuardRecordShortCircuit(width);
}

+ (nullable NSString *)sessionSummaryResetting:(BOOL)reset {
    return LeoGuardSessionSummary(reset);
}

@end
