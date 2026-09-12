#!/usr/bin/env python3
"""Compile CameraOffload.m's real wait function against side-effect-free fakes."""
from pathlib import Path
import subprocess
import tempfile
import sys

root = Path(__file__).resolve().parent.parent
source = (root / 'src/ios/NativeOffloads/CameraOffload.m').read_text()
start = source.index('static int wait_and_emit(')
brace = source.index('{', start)
depth, end = 1, brace + 1
while depth:
    depth += (source[end] == '{') - (source[end] == '}')
    end += 1
function = source[start:end]
new_api = 'CameraCaptureOperation *operation' in function
prefix = r'''
#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#include <errno.h>
static NSString *TOOL_NAME = @"apple-camera";
static NSString *NOFF_ERR_INTERNAL_ERROR = @"internal_error";
static NSString *NOFF_ERR_NO_DATA = @"no_data";
static NSString *NOFF_ERR_AUTHORIZATION_DENIED = @"authorization_denied";
enum { NOFF_EXIT_SUCCESS = 0, NOFF_EXIT_ERROR = 1, NOFF_EXIT_AUTH_DENIED = 3, NOFF_EXIT_NOT_AVAILABLE = 4 };
static long simulated_wait;
static NSDictionary *emitted;
static int closed;
static BOOL noff_is_cancelled(void) { return NO; }
@interface CameraCaptureOperation : NSObject
@property BOOL cancelled;
@property BOOL timedOut;
- (void)requestCancellationWithTimedOut:(BOOL)timedOut;
@end
@implementation CameraCaptureOperation
- (void)requestCancellationWithTimedOut:(BOOL)timedOut { self.cancelled = YES; self.timedOut = timedOut; }
@end
@interface CameraOffloadBridge : NSObject
+ (void)cancelOperation:(CameraCaptureOperation *)operation;
@end
@implementation CameraOffloadBridge
+ (void)cancelOperation:(CameraCaptureOperation *)operation { (void)operation; closed++; }
@end
static NSDictionary *noff_json_error(NSString *tool, NSString *action, NSString *code, NSString *message) {
    return @{@"tool":tool, @"action":action, @"code":code, @"message":message};
}
static NSDictionary *noff_json_envelope(NSString *tool, NSString *action, id data) {
    return @{@"tool":tool, @"action":action, @"data":data};
}
static void noff_emit_json(int fd, NSDictionary *value, BOOL compact, BOOL quiet) {
    (void)fd; (void)compact; (void)quiet; emitted = value;
}
#define dispatch_semaphore_wait(sem, timeout) simulated_wait
#define dispatch_async(queue, block) (block)()
'''
call = 'wait_and_emit(@"photo", operation, semaphore, &data, &error, -1, NO, NO)' if new_api else 'wait_and_emit(@"photo", semaphore, &data, &error, -1, NO, NO)'
main = '''
int main(void) { @autoreleasepool {
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    CameraCaptureOperation *operation = [CameraCaptureOperation new];
    NSDictionary *data = nil;
    ERROR_TYPE *error = nil;
    simulated_wait = ECANCELED;
    int result = CALL;
    if (result != 130 || ![emitted[@"code"] isEqualToString:@"cancelled"]) {
        fprintf(stderr, "FAIL: real camera wait must classify cancellation as cancelled/130, not timeout\\n"); return 1;
    }
    if (!operation.cancelled || operation.timedOut || closed != 1) {
        fprintf(stderr, "FAIL: cancellation must synchronously mark the operation and close matching UI\\n"); return 1;
    }
    operation = [CameraCaptureOperation new];
    simulated_wait = ETIMEDOUT;
    result = CALL;
    if (result != 1 || ![emitted[@"code"] isEqualToString:@"timed_out"] || !operation.timedOut || closed != 2) {
        fprintf(stderr, "FAIL: timeout must be distinct and close its operation\\n"); return 1;
    }
    puts("PASS: actual CameraOffload wait cancellation, timeout, and UI cleanup dispatch");
    return 0;
} }
'''.replace('ERROR_TYPE', 'NSError' if new_api else 'NSString').replace('CALL', call)
with tempfile.TemporaryDirectory(prefix='ios-camera-wait-') as tmp:
    fixture = Path(tmp) / 'CameraWaitSmoke.m'
    fixture.write_text(prefix + function + main)
    binary = Path(tmp) / 'smoke'
    result = subprocess.run(['clang', '-fobjc-arc', '-fblocks', '-framework', 'Foundation', str(fixture), '-o', str(binary)])
    if result.returncode == 0:
        result = subprocess.run([str(binary)])
    sys.exit(result.returncode)
