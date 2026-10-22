//
//  ISHSimulatorStubs.m
//  LeoPhoneAgent
//
//  iOS Simulator-only stand-ins for the iSH kernel and FFmpeg offload.
//
//  deps/libs/lib{ish_emu,ish,fakefs}.a and deps/frameworks/{FFmpeg,libav*,libsw*}
//  are built for iphoneos only. For iphonesimulator the project excludes them
//  (OTHER_LDFLAGS[sdk=iphoneos*], EXCLUDED_SOURCE_FILE_NAMES[sdk=iphonesimulator*])
//  together with the sources that call into them (ISHKernel.m, ISHShellExecutor.m,
//  CurrentRoot.m, FFmpegOffload.m) and compiles this file instead. Device builds
//  exclude this file, so they are unchanged.
//
//  Everything here reports "not available": the kernel never boots, shell
//  commands fail to start, and native offloads are never registered.
//

#import <TargetConditionals.h>

#if TARGET_OS_SIMULATOR

#import "ISHKernel.h"
#import "ISHShellExecutor.h"
#import "CurrentRoot.h"
#import "FFmpegOffload.h"
#include "kernel/errno.h"
#include "kernel/native_offload.h"
#include "kernel/task.h"
#include "kernel/fs.h"
#include "fs/fd.h"
#include "fs/fake.h"

static NSString *const kISHSimulatorUnavailable = @"The local Linux shell (iSH) is not available in the iOS Simulator.";

NSNotificationName const ISHProcessExitedNotification = @"ISHProcessExited";
NSNotificationName const ISHTerminalOutputNotification = @"ISHTerminalOutput";

#pragma mark - ISHKernel

@implementation ISHKernel

+ (ISHKernel *)shared {
    static ISHKernel *instance;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ instance = [[ISHKernel alloc] init]; });
    return instance;
}

- (BOOL)isBooted { return NO; }

- (int)bootWithRootPath:(NSString *)rootPath {
    NSLog(@"[ISHSimulatorStubs] %@", kISHSimulatorUnavailable);
    return _ENOSYS;
}

- (int)executeCommand:(NSArray<NSString *> *)command { return _ENOSYS; }

- (void)executeCommandAndWait:(NSString *)commandString
                      timeout:(NSTimeInterval)timeout
                   completion:(ISHCommandCompletionCallback)completion {
    NSError *error = [NSError errorWithDomain:@"ISHKernel" code:_ENOSYS
                                     userInfo:@{NSLocalizedDescriptionKey: kISHSimulatorUnavailable}];
    dispatch_async(dispatch_get_main_queue(), ^{ completion(@"", error); });
}

- (void)sendInput:(NSData *)data {}
- (void)sendInputString:(NSString *)input {}
- (void)setTerminalSize:(int)columns rows:(int)rows {}
- (int)bindMountPath:(NSString *)linuxPath toHostPath:(NSString *)hostPath { return _ENOSYS; }
- (int)bindMountPath:(NSString *)linuxPath toHostPath:(NSString *)hostPath readOnly:(BOOL)readOnly { return _ENOSYS; }
- (int)bindUnmountPath:(NSString *)linuxPath { return _ENOSYS; }
- (void)refreshDns {}

@end

@implementation ISHFakefsChangeEvent
- (NSString *)linuxPath { return @""; }
- (int)op { return 0; }
- (int64_t)timestampNs { return 0; }
- (uint64_t)fsContext { return 0; }
@end

@implementation ISHKernel (FakefsChange)
- (void)installFakefsChangeHandler:(void (^)(NSArray<ISHFakefsChangeEvent *> *))handler {}
- (uint64_t)fakefsChangeDroppedCount { return 0; }
@end

@implementation ISHKernel (PathTranslate)
- (void)installPathTranslateHandler:(ISHPathTranslateHandler)handler {}
@end

@implementation ISHKernel (PathReverse)
- (void)installPathReverseHandler:(ISHPathReverseHandler)handler {}
@end

@implementation ISHKernel (Scheduler)
- (void)enableCPUThrottleWithDutyCycle:(float)dutyCycle {}
- (void)disableCPUThrottle {}
- (void)beginBackgroundCPUGovernor {}
- (void)endBackgroundCPUGovernor {}
@end

#pragma mark - ISHShellExecutor

@interface ISHShellExecutionResult ()
@property (nonatomic, readwrite) int exitCode;
@property (nonatomic, readwrite) ISHShellExecutorError error;
@property (nonatomic, readwrite, copy) NSString *output;
@property (nonatomic, readwrite, copy) NSString *errorOutput;
@end

@implementation ISHShellExecutionResult
@end

@implementation ISHShellExecutor

// Same contract as the device implementation when the kernel is not booted:
// return ProcessCreationFailed and never invoke the callbacks.
+ (int)executeCommand:(NSString *)command
         lineCallback:(ISHShellLineCallback)lineCallback
           completion:(ISHShellCompletionCallback)completion {
    return ISHShellExecutorErrorProcessCreationFailed;
}

+ (int)executeExecutable:(NSString *)executable
               arguments:(NSArray<NSString *> *)arguments
             environment:(NSDictionary<NSString *, NSString *> *)environment
            lineCallback:(ISHShellLineCallback)lineCallback
              completion:(ISHShellCompletionCallback)completion {
    return ISHShellExecutorErrorProcessCreationFailed;
}

+ (int)executeExecutable:(NSString *)executable
               arguments:(NSArray<NSString *> *)arguments
             environment:(NSDictionary<NSString *, NSString *> *)environment
               stdinData:(NSData *)stdinData
            lineCallback:(ISHShellLineCallback)lineCallback
              completion:(ISHShellCompletionCallback)completion {
    return ISHShellExecutorErrorProcessCreationFailed;
}

+ (int)executeExecutable:(NSString *)executable
               arguments:(NSArray<NSString *> *)arguments
             environment:(NSDictionary<NSString *, NSString *> *)environment
               stdinData:(NSData *)stdinData
               fsContext:(uint64_t)fsContext
            lineCallback:(ISHShellLineCallback)lineCallback
              completion:(ISHShellCompletionCallback)completion {
    return ISHShellExecutorErrorProcessCreationFailed;
}

+ (ISHShellExecutionResult *)executeCommandSync:(NSString *)command
                                        timeout:(NSTimeInterval)timeout
                                   lineCallback:(ISHShellLineCallback)lineCallback {
    ISHShellExecutionResult *result = [[ISHShellExecutionResult alloc] init];
    result.error = ISHShellExecutorErrorProcessCreationFailed;
    result.exitCode = -1;
    result.output = @"";
    result.errorOutput = kISHSimulatorUnavailable;
    return result;
}

+ (BOOL)killProcess:(int)pid withSignal:(int)signal { return NO; }
+ (void)killProcessGroup:(int)pid {}
+ (void)finalizeTimedOutPid:(int)pid {}
+ (NSString *)leakGuardStatus { return @"activeExecutions=0 liveReaders=0 sweptContexts=0"; }

@end

#pragma mark - C entry points from excluded sources

void FsApplyOverlay(void) {}
void ffmpeg_offload_register(void) {}

#pragma mark - iSH kernel symbols used by NativeOffloadUtils.m

// NativeOffloadUtils.m stays compiled (every offload uses its helpers). Its
// kernel calls only run once the kernel has booted, which never happens here.
__thread struct task *current;  // stays NULL: no guest task ever runs
int (native_offload_add_handler)(const char *guest_name, native_handler_func handler) { return _ENOSYS; }
int native_offload_set_abort_handler(const char *guest_name, native_abort_func abort_fn) { return _ENOSYS; }
bool fakefs_bind_mount_translate_path(const char *path, char *out_path, size_t out_size) { return false; }
struct fd *generic_open(const char *path, int flags, int mode) { return ERR_PTR(_ENOSYS); }
int generic_mkdirat(struct fd *at, const char *path, mode_t_ mode) { return _ENOSYS; }
int fd_close(struct fd *fd) { return 0; }

#endif // TARGET_OS_SIMULATOR
