#!/usr/bin/env python3
"""Run the actual apple-device control parser against a harmless bridge fake."""
from pathlib import Path
import subprocess
import tempfile
import sys

root = Path(__file__).resolve().parent.parent
def function(source, marker):
    start = source.index(marker)
    brace = source.index('{', start)
    depth, end = 1, brace + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]
source = (root / 'src/ios/NativeOffloads/DeviceOffload.m').read_text()
utils = (root / 'src/ios/NativeOffloads/NativeOffloadUtils.m').read_text()
bodies = '\n'.join([
    function(utils, 'NSString *_Nullable noff_find_arg('),
    function(utils, 'BOOL noff_has_flag('),
    function(source, 'static NSNumber *device_number('),
    function(source, 'static int device_invalid('),
    function(source, 'static int cmd_control('),
    function(source, 'static NSString *device_subcommand('),
])
prefix = r'''
#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#include <errno.h>
#include <math.h>
static NSString *TOOL_NAME = @"apple-device";
static NSString *NOFF_ERR_INTERNAL_ERROR = @"internal_error";
static NSString *NOFF_ERR_INVALID_ARGS = @"invalid_args";
enum { NOFF_EXIT_SUCCESS=0, NOFF_EXIT_ERROR=1, NOFF_EXIT_INVALID_ARGS=2 };
static long simulated_wait;
static NSDictionary *emitted;
static int bridge_calls, cancelled;
static NSNumber *last_enabled, *last_level;
static NSError *bridge_error;
static BOOL noff_is_cancelled(void) { return NO; }
@interface DeviceActionRequest : NSObject
- (void)cancel;
@end
@implementation DeviceActionRequest
- (void)cancel { cancelled++; }
@end
@interface DeviceActionsBridge : NSObject
+ (DeviceActionRequest *)performAction:(NSString *)action enabled:(NSNumber *)enabled level:(NSNumber *)level completion:(void (^)(NSDictionary *, NSError *))completion;
@end
@implementation DeviceActionsBridge
+ (DeviceActionRequest *)performAction:(NSString *)action enabled:(NSNumber *)enabled level:(NSNumber *)level completion:(void (^)(NSDictionary *, NSError *))completion {
    (void)action; bridge_calls++; last_enabled=enabled; last_level=level;
    completion(@{@"observed":@YES},bridge_error); return [DeviceActionRequest new];
}
@end
static NSDictionary *noff_json_error(NSString *tool, NSString *action, NSString *code, NSString *message) {
    return @{@"ok":@NO,@"tool":tool,@"action":action,@"error":@{@"code":code,@"message":message}};
}
static NSDictionary *noff_json_envelope(NSString *tool, NSString *action, id data) {
    return @{@"ok":@YES,@"tool":tool,@"action":action,@"data":data};
}
static void noff_emit_json(int fd, NSDictionary *value, BOOL compact, BOOL quiet) {
    (void)fd;(void)compact;(void)quiet;emitted=value;
}
#define dispatch_semaphore_wait(sem, timeout) simulated_wait
'''
main = r'''
#define CHECK(cond, message) do { if (!(cond)) { fprintf(stderr,"FAIL: %s\n",message); return 1; } } while(0)
static int run(NSArray<NSString *> *arguments) {
    int argc=(int)arguments.count;
    char **argv=calloc(argc+1,sizeof(char *));
    for(int i=0;i<argc;i++) argv[i]=strdup(arguments[i].UTF8String);
    NSString *command=device_subcommand(argc,argv);
    int result=cmd_control(command,argc,argv,-1,NO,NO);
    for(int i=0;i<argc;i++) free(argv[i]); free(argv); return result;
}
int main(void) { @autoreleasepool {
    CHECK(run(@[@"apple-device",@"torch",@"--set",@"on",@"--level",@"0.5"])==0,"valid torch set");
    CHECK(last_enabled.boolValue && last_level.doubleValue==0.5,"typed torch parameters");
    NSArray *bad=@[
      @[@"apple-device",@"brightness",@"--set",@"banana"],
      @[@"apple-device",@"brightness",@"--set",@"nan"],
      @[@"apple-device",@"brightness",@"--set",@"1.1"],
      @[@"apple-device",@"brightness",@"--set",@"-0.1"],
      @[@"apple-device",@"torch",@"--level",@"0.5"],
      @[@"apple-device",@"torch",@"--status",@"--set",@"on"],
      @[@"apple-device",@"torch",@"--set"],
      @[@"apple-device",@"torch",@"--set",@"on",@"--set",@"off"],
      @[@"apple-device",@"torch",@"on"]
    ];
    int before=bridge_calls;
    for(NSArray *args in bad) CHECK(run(args)==2,"invalid device arguments fail before bridge");
    CHECK(before==bridge_calls,"invalid values must not reach hardware bridge");
    CHECK(run(@[@"apple-device",@"--compact",@"torch",@"--set",@"off"])==0 && !last_enabled.boolValue,"global flags preserve native action");
    CHECK(run(@[@"apple-device",@"torch",@"--status"])==0 && last_enabled==nil && last_level==nil,"status must remain read-only");
    CHECK(run(@[@"apple-device",@"brightness",@"--set",@"0.6"])==0 && last_level.doubleValue==0.6,"brightness set");
    bridge_error=[NSError errorWithDomain:@"fixture" code:1 userInfo:@{@"code":@"state_unconfirmed",NSLocalizedDescriptionKey:@"not confirmed",@"observed_state":@{@"enabled":@NO}}];
    CHECK(run(@[@"apple-device",@"torch",@"--set",@"on"])==1,"unconfirmed is not success");
    CHECK([emitted[@"error"][@"code"] isEqualToString:@"state_unconfirmed"] && emitted[@"error"][@"observed_state"]!=nil,"unknown retains observed state");
    bridge_error=nil; simulated_wait=ECANCELED;
    CHECK(run(@[@"apple-device",@"torch",@"--status"])==130 && cancelled==1,"native cancellation reaches request token");
    puts("PASS: actual device CLI parsing, invalid-number rejection, read-only status, observed errors and cancellation");
    return 0;
} }
'''
with tempfile.TemporaryDirectory(prefix='ios-device-control-') as tmp:
    fixture=Path(tmp)/'DeviceSmoke.m'
    fixture.write_text(prefix+bodies+main)
    binary=Path(tmp)/'smoke'
    result=subprocess.run(['clang','-fobjc-arc','-fblocks','-framework','Foundation',str(fixture),'-o',str(binary)])
    if result.returncode==0: result=subprocess.run([str(binary)])
    sys.exit(result.returncode)
