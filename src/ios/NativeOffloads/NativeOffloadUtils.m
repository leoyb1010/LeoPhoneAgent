//
//  NativeOffloadUtils.m
//  MinisApp
//
//  Shared utilities for native offload CLI tools.
//

#import "NativeOffloadUtils.h"
#import "NativeOffloadDispatch.h"
#import "LeoPhoneAgent-Swift.h"
#include "kernel/task.h"
#include "kernel/fs.h"
#include "fs/fd.h"
#include "fs/path.h"
#include <unistd.h>
#include <sys/select.h>
#include <errno.h>

// ── Error code constants ──
NSString *const NOFF_ERR_AUTHORIZATION_DENIED       = @"authorization_denied";
NSString *const NOFF_ERR_AUTHORIZATION_NOT_DETERMINED = @"authorization_not_determined";
NSString *const NOFF_ERR_NOT_AVAILABLE              = @"not_available";
NSString *const NOFF_ERR_INVALID_ARGS               = @"invalid_args";
NSString *const NOFF_ERR_NO_DATA                    = @"no_data";
NSString *const NOFF_ERR_INTERNAL_ERROR             = @"internal_error";

// ── Cooperative cancellation ──

BOOL noff_is_cancelled(void) {
    return native_offload_handler_cancelled() ? YES : NO;
}

long noff_dispatch_semaphore_wait(dispatch_semaphore_t semaphore, dispatch_time_t timeout) {
    const int64_t pollNanos = 100 * NSEC_PER_MSEC;
    while (true) {
        if (noff_is_cancelled()) return ECANCELED;

        dispatch_time_t now = dispatch_time(DISPATCH_TIME_NOW, 0);
        if (timeout != DISPATCH_TIME_FOREVER && now >= timeout) return ETIMEDOUT;

        dispatch_time_t pollDeadline = dispatch_time(DISPATCH_TIME_NOW, pollNanos);
        dispatch_time_t nextDeadline = timeout == DISPATCH_TIME_FOREVER
            ? pollDeadline
            : MIN(pollDeadline, timeout);
        // Parenthesized spelling bypasses the function-like macro declared in
        // NativeOffloadUtils.h so this wrapper reaches libdispatch itself.
        long result = (dispatch_semaphore_wait)(semaphore, nextDeadline);
        if (result == 0) return 0;
    }
}

// ── Native execution authorization ──

static int noff_authorize_native(const char *registered_name, int argc, char **argv,
                                  int stdout_fd, int stderr_fd) {
    (void)stderr_fd;
    @autoreleasepool {
        NSString *command = [NSString stringWithUTF8String:registered_name];
        BOOL compact = noff_has_flag(argc, argv, "--compact");
        BOOL quiet = noff_has_flag(argc, argv, "--quiet") || noff_has_flag(argc, argv, "-q");
        if ([NSThread isMainThread]) {
            // A synchronous wait on MainActor would prevent the permission UI
            // and even the callback from running. Direct UI routes use the
            // async Swift authorize API instead of this guest-thread API.
            noff_emit_json(stdout_fd, noff_json_error(command, @"authorize", @"needs_async_entry",
                @"设备操作需要异步授权，不能在主线程同步执行。请从任务入口重试。"), compact, quiet);
            return NOFF_EXIT_AUTH_DENIED;
        }
        if (noff_is_cancelled()) return 130;
        NSMutableArray<NSString *> *arguments = [NSMutableArray array];
        for (int i = 1; i < argc; i++) {
            NSString *argument = argv[i] ? [NSString stringWithUTF8String:argv[i]] : nil;
            if (!argument) {
                noff_emit_json(stdout_fd, noff_json_error(command, @"authorize", NOFF_ERR_INVALID_ARGS,
                    @"设备操作参数不是有效 UTF-8，操作未执行。"), compact, quiet);
                return NOFF_EXIT_INVALID_ARGS;
            }
            [arguments addObject:argument];
        }
        // fs_context is set by ISHShellExecutor before exec and inherited by
        // forks. Guest environment variables and argv cannot replace it.
        uint64_t context = current && current->group ? current->group->fs_context : 0;
        dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
        __block NSString *errorCode = nil;
        __block NSString *message = nil;
        NativeOffloadPermissionOperation *operation = [NativeOffloadPermissionBridge
            authorizeCommand:command arguments:arguments fsContext:context
            completion:^(NSString *code, NSString *detail) {
                errorCode = code;
                message = detail;
                dispatch_semaphore_signal(semaphore);
            }];
        // The Swift queue owns a 30-second deadline. This outer deadline also
        // bounds a delayed/unresponsive UI actor, and polls native cancellation.
        long wait = noff_dispatch_semaphore_wait(semaphore,
            dispatch_time(DISPATCH_TIME_NOW, 35 * NSEC_PER_SEC));
        if (wait != 0) {
            [operation cancel];
            BOOL cancelled = wait == ECANCELED || noff_is_cancelled();
            noff_emit_json(stdout_fd, noff_json_error(command, @"authorize",
                cancelled ? @"cancelled" : @"authorization_timeout",
                cancelled ? @"已取消授权，设备操作没有执行。" : @"等待设备授权超时，操作没有执行。"), compact, quiet);
            return cancelled ? 130 : NOFF_EXIT_AUTH_DENIED;
        }
        if (noff_is_cancelled()) { [operation cancel]; return 130; }
        if (errorCode) {
            noff_emit_json(stdout_fd, noff_json_error(command, @"authorize", errorCode,
                message ?: @"设备操作未获授权。"), compact, quiet);
            return [errorCode isEqualToString:@"cancelled"] ? 130 : NOFF_EXIT_AUTH_DENIED;
        }
        return NOFF_EXIT_SUCCESS;
    }
}

int noff_register_authorized_handler(const char *guest_name, native_handler_func handler) {
    // Non-device helpers have their own policy. All apple-* tools, including
    // future registrations importing this header, must use the guarded slots.
    if (!guest_name || strncmp(guest_name, "apple-", 6) != 0)
        return (native_offload_add_handler)(guest_name, handler);
    return noff_dispatch_register(guest_name, handler, noff_authorize_native,
                                  (native_offload_add_handler));
}

// ── Argument helpers ──

NSString *_Nullable noff_find_arg(int argc, char **argv, const char *name) {
    for (int i = 1; i < argc - 1; i++) {
        if (strcmp(argv[i], name) == 0) {
            return [NSString stringWithUTF8String:argv[i + 1]];
        }
    }
    return nil;
}

BOOL noff_has_flag(int argc, char **argv, const char *name) {
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], name) == 0) return YES;
    }
    return NO;
}

NSString *_Nullable noff_get_subcommand(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        if (argv[i][0] != '-') {
            return [NSString stringWithUTF8String:argv[i]];
        }
        // Skip argument value for known option patterns (--key value)
        if (argv[i][0] == '-' && argv[i][1] == '-' && i + 1 < argc && argv[i + 1][0] != '-') {
            i++; // skip value
        }
    }
    return nil;
}

NSArray<NSString *> *noff_positional_args(int argc, char **argv) {
    NSMutableArray *args = [NSMutableArray array];
    BOOL foundSubcommand = NO;
    for (int i = 1; i < argc; i++) {
        if (argv[i][0] == '-') {
            // Skip option and its value
            if (argv[i][1] == '-' && i + 1 < argc && argv[i + 1][0] != '-') {
                i++;
            }
            continue;
        }
        if (!foundSubcommand) {
            foundSubcommand = YES;
            continue; // skip the subcommand itself
        }
        [args addObject:[NSString stringWithUTF8String:argv[i]]];
    }
    return args;
}

// ── Date parsing ──

NSDate *_Nullable noff_parse_date(NSString *str) {
    if (!str || str.length == 0) return nil;

    // Relative: -7d, -2h, -30m
    if ([str hasPrefix:@"-"] && str.length >= 2) {
        unichar unit = [str characterAtIndex:str.length - 1];
        NSString *numStr = [str substringWithRange:NSMakeRange(1, str.length - 2)];
        NSInteger num = [numStr integerValue];
        if (num > 0) {
            NSTimeInterval interval = 0;
            switch (unit) {
                case 'd': interval = num * 86400; break;
                case 'h': interval = num * 3600; break;
                case 'm': interval = num * 60; break;
                default: break;
            }
            if (interval > 0) {
                return [NSDate dateWithTimeIntervalSinceNow:-interval];
            }
        }
    }

    // ISO 8601 variants
    NSISO8601DateFormatter *iso = [[NSISO8601DateFormatter alloc] init];
    iso.formatOptions = NSISO8601DateFormatWithInternetDateTime
                      | NSISO8601DateFormatWithFractionalSeconds;
    NSDate *d = [iso dateFromString:str];
    if (d) return d;

    // Without fractional seconds
    iso.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    d = [iso dateFromString:str];
    if (d) return d;

    // Date-only or datetime without timezone
    NSDateFormatter *fmt = [[NSDateFormatter alloc] init];
    fmt.locale = [[NSLocale alloc] initWithLocaleIdentifier:@"en_US_POSIX"];
    fmt.timeZone = [NSTimeZone localTimeZone];
    for (NSString *pattern in @[@"yyyy-MM-dd'T'HH:mm:ss",
                                 @"yyyy-MM-dd'T'HH:mm",
                                 @"yyyy-MM-dd"]) {
        fmt.dateFormat = pattern;
        d = [fmt dateFromString:str];
        if (d) return d;
    }

    return nil;
}

NSString *noff_format_date(NSDate *date) {
    if (!date) return @"";
    NSISO8601DateFormatter *fmt = [[NSISO8601DateFormatter alloc] init];
    fmt.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    fmt.timeZone = [NSTimeZone localTimeZone];
    return [fmt stringFromDate:date];
}

// ── JSON output ──

NSDictionary *noff_json_envelope(NSString *tool, NSString *action, id data) {
    return @{
        @"ok": @YES,
        @"tool": tool,
        @"action": action,
        @"data": data ?: [NSNull null],
        @"timestamp": noff_format_date([NSDate date]),
    };
}

NSDictionary *noff_json_error(NSString *tool, NSString *action,
                               NSString *code, NSString *message) {
    return @{
        @"ok": @NO,
        @"tool": tool,
        @"action": action,
        @"error": @{
            @"code": code,
            @"message": message,
        },
        @"timestamp": noff_format_date([NSDate date]),
    };
}

void noff_emit_json(int fd, NSDictionary *dict, BOOL compact, BOOL quiet) {
    id output = dict;
    if (quiet) {
        // In quiet mode, emit only the "data" field for success, or "error" for failure
        if ([dict[@"ok"] boolValue]) {
            output = dict[@"data"];
        } else {
            output = dict[@"error"];
        }
    }

    if (!output || output == [NSNull null]) {
        dprintf(fd, "{}\n");
        return;
    }

    NSJSONWritingOptions opts = 0;
    if (!compact) {
        opts = NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys;
    }

    NSError *err = nil;
    NSData *json = nil;
    @try {
        json = [NSJSONSerialization dataWithJSONObject:output options:opts error:&err];
    } @catch (NSException *e) {
        NSLog(@"NativeOffloads: JSON serialization exception: %@", e.reason);
    }
    if (!json) {
        dprintf(fd, "{\"error\":\"json_serialization_failed\"}\n");
        return;
    }

    NSString *str = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    dprintf(fd, "%s\n", str.UTF8String);
}

// ── Help output ──

void noff_emit_help(int stderr_fd, NSString *helpText) {
    dprintf(stderr_fd, "%s\n", helpText.UTF8String);
}

// ── Main thread dispatch ──

id _Nullable noff_dispatch_main_sync(id _Nullable (^block)(void)) {
    if ([NSThread isMainThread]) {
        return block();
    }
    __block id result = nil;
    dispatch_sync(dispatch_get_main_queue(), ^{
        result = block();
    });
    return result;
}

// ── Read stdin ──

// ── Guest stub creation ──

void noff_ensure_guest_stub(const char *guest_path) {
    // Ensure parent directories exist (e.g. /usr/local/bin)
    char parent[256];
    strncpy(parent, guest_path, sizeof(parent) - 1);
    parent[sizeof(parent) - 1] = '\0';

    // Walk through the path and mkdir each component
    for (char *p = parent + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            generic_mkdirat(AT_PWD, parent, 0755);
            *p = '/';
        }
    }

    // Create the stub file with execute permission.
    // O_CREAT without O_EXCL: if it already exists, just opens it.
    struct fd *fd = generic_open(guest_path, O_CREAT_ | O_WRONLY_, 0755);
    if (fd && !IS_ERR(fd)) {
        fd_close(fd);
    }
}

// ── Path resolution ──

NSString *_Nullable noff_resolve_host_path(NSString *guestPath) {
    if (guestPath.length == 0) return nil;

    // Documents/alpine-rootfs/data/ is the fakefs data root
    NSString *documents = NSSearchPathForDirectoriesInDomains(
        NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
    NSString *dataRoot = [documents stringByAppendingPathComponent:@"alpine-rootfs/data"];

    // Strip leading "/" from guest path and append to host data root
    NSString *relative = guestPath;
    while ([relative hasPrefix:@"/"]) {
        relative = [relative substringFromIndex:1];
    }
    return [dataRoot stringByAppendingPathComponent:relative];
}

// ── Read stdin ──

NSString *_Nullable noff_read_stdin(int stdin_fd) {
    if (stdin_fd < 0) return nil;

    NSMutableData *data = [NSMutableData data];
    char buf[4096];
    ssize_t n;

    // Use select with a short timeout to check if data is available
    fd_set fds;
    struct timeval tv = { .tv_sec = 0, .tv_usec = 100000 }; // 100ms
    FD_ZERO(&fds);
    FD_SET(stdin_fd, &fds);

    while (select(stdin_fd + 1, &fds, NULL, NULL, &tv) > 0) {
        n = read(stdin_fd, buf, sizeof(buf));
        if (n <= 0) break;
        [data appendBytes:buf length:n];
        if (data.length > 1024 * 1024) break; // 1MB cap

        FD_ZERO(&fds);
        FD_SET(stdin_fd, &fds);
        tv.tv_sec = 0;
        tv.tv_usec = 50000; // 50ms for subsequent reads
    }

    if (data.length == 0) return nil;
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

// ── ObjC exception safety ──

BOOL noff_try_objc(void (NS_NOESCAPE ^block)(void)) {
    @try {
        block();
        return YES;
    } @catch (NSException *e) {
        NSLog(@"noff_try_objc: caught ObjC exception: %@ — %@", e.name, e.reason);
        return NO;
    }
}
