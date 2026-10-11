//
//  NSTextContainerSetSizeGuard.h
//  LeoPhoneAgent
//
//  Reentrancy guard for -[NSTextContainer setSize:].
//
//  Background: NSTextContainer.setSize: triggers
//  -[NSLayoutManager textContainerChangedGeometry:] which calls
//  _invalidateLayoutForExtendedCharacterRange and re-enters
//  _fillLayoutHole. On iOS 26 TextKit1 with markdown tables hosted in
//  UITextView, a single SwiftUI geometry-commit can drive several
//  redundant setSize calls in the same runloop tick (same container,
//  same value), each of which retriggers the typesetter feedback loop.
//  Repeated enough times this exceeds the 10s scene-update watchdog
//  and the system kills the app with 0x8BADF00D.
//
//  This guard swizzles setSize: and skips calls that would not change
//  the container's size (UIKit's own sizeThatFits set/restore pairs are
//  the main source), plus repeated same-value calls in one runloop tick.
//  Oversized values are clamped to `unboundedDimension`.
//
//  Logs one per-session summary (counts by width) when the app leaves the
//  foreground, and only if something was short-circuited or rejected.

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

NS_ASSUME_NONNULL_BEGIN

@interface NSTextContainerSetSizeGuard : NSObject

/// Install the swizzle. Call once at app launch on the main thread.
+ (void)install;

/// Total number of short-circuited setSize: calls since install.
/// Visible for debugging and analytics; updated on main thread.
+ (uint64_t)shortCircuitCount;

/// Main-thread setSize: calls forwarded to NSTextContainer since install.
+ (uint64_t)forwardedCount;

/// The value any larger width/height (incl. .greatestFiniteMagnitude) is clamped to.
+ (CGFloat)unboundedDimension;

/// Main-thread setSize: calls skipped because the size was already current.
+ (uint64_t)identicalSkipCount;

/// The per-session summary line (nil when nothing was short-circuited or
/// rejected). `reset` clears the session counters.
+ (nullable NSString *)sessionSummaryResetting:(BOOL)reset;

/// Tests only: count one short-circuit at `width` in the session summary.
+ (void)recordShortCircuitForTestingWidth:(CGFloat)width;

@end

NS_ASSUME_NONNULL_END
