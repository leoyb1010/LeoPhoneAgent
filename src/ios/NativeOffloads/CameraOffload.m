//
//  CameraOffload.m
//  MinisApp
//
//  Native offload handler for `apple-camera`.
//  Subcommands: photo, scan-code, scan-document, status
//
//  规格书 B·P0「拍照、录像、扫码」:此前只有聊天输入栏的人肉拍照,Agent
//  无法程序化发起采集。三个子命令都弹系统 UI 由用户亲手拍/扫——绝无静默
//  采集(X 级红线)。产物落 /var/minis/offloads/,与 apple-vision 串成闭环
//  (拍→OCR→结构化)。
//

#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>
#import "NativeOffloadUtils.h"
#include "kernel/native_offload.h"

#import "LeoPhoneAgent-Swift.h"

static NSString *const TOOL_NAME = @"apple-camera";

static NSString *const HELP_TEXT =
    @"apple-camera - Camera capture (user-operated system UI)\n"
     "\n"
     "USAGE:\n"
     "  apple-camera <command> [options]\n"
     "\n"
     "COMMANDS:\n"
     "  photo          Open the camera; the user takes one photo\n"
     "  scan-code      Open the barcode/QR scanner; returns the first code\n"
     "  scan-document  Open the document scanner; saves each page as JPEG\n"
     "  status         Camera authorization status\n"
     "\n"
     "COMMON OPTIONS:\n"
     "  --help, -h           Show this help message\n"
     "  --compact            Minimize JSON output\n"
     "  -q, --quiet          Output only data field\n"
     "\n"
     "PHOTO OPTIONS:\n"
     "  --camera front|back  Which camera to start with (default back)\n"
     "\n"
     "EXAMPLES:\n"
     "  apple-camera photo\n"
     "  apple-camera photo --camera front\n"
     "  apple-camera scan-code\n"
     "  apple-camera scan-document\n"
     "  apple-camera status\n"
     "\n"
     "Captured files land in /var/minis/offloads/. Chain with apple-vision:\n"
     "  apple-camera scan-document && apple-vision ocr /var/minis/offloads/scan-...jpg\n"
     "\n"
     "NOTE: all commands present a camera UI — the app must be in the\n"
     "foreground and the user performs the capture.\n";

/// Shared wait-for-bridge pattern: block up to 300s while the user operates
/// the capture UI; cooperative cancellation via noff_dispatch_semaphore_wait.
static int wait_and_emit(NSString *action, dispatch_semaphore_t sem,
                         NSDictionary *__strong *result, NSString *__strong *errorMsg,
                         int stdout_fd, BOOL compact, BOOL quiet) {
    long waitResult = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_SEC));
    if (waitResult != 0) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, action, NOFF_ERR_INTERNAL_ERROR,
                       @"Timed out waiting for the camera UI."), compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    if (*errorMsg) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, action, NOFF_ERR_NO_DATA, *errorMsg),
                       compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, action, *result ?: @{}), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static int cmd_photo(int argc, char **argv, int stdout_fd, BOOL compact, BOOL quiet) {
    NSString *camera = noff_find_arg(argc, argv, "--camera") ?: @"back";
    NSString *guestDir = @"/var/minis/offloads";
    NSString *hostDir = noff_resolve_host_path(guestDir);

    __block NSDictionary *result = nil;
    __block NSString *errorMsg = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);

    dispatch_async(dispatch_get_main_queue(), ^{
        [CameraOffloadBridge takePhotoWithCamera:camera hostDir:hostDir guestDir:guestDir
                                      completion:^(NSDictionary *data, NSString *error) {
            result = data;
            errorMsg = error;
            dispatch_semaphore_signal(sem);
        }];
    });
    return wait_and_emit(@"photo", sem, &result, &errorMsg, stdout_fd, compact, quiet);
}

static int cmd_scan_code(int stdout_fd, BOOL compact, BOOL quiet) {
    __block NSDictionary *result = nil;
    __block NSString *errorMsg = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);

    dispatch_async(dispatch_get_main_queue(), ^{
        [CameraOffloadBridge scanCodeWithCompletion:^(NSDictionary *data, NSString *error) {
            result = data;
            errorMsg = error;
            dispatch_semaphore_signal(sem);
        }];
    });
    return wait_and_emit(@"scan-code", sem, &result, &errorMsg, stdout_fd, compact, quiet);
}

static int cmd_scan_document(int stdout_fd, BOOL compact, BOOL quiet) {
    NSString *guestDir = @"/var/minis/offloads";
    NSString *hostDir = noff_resolve_host_path(guestDir);

    __block NSDictionary *result = nil;
    __block NSString *errorMsg = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);

    dispatch_async(dispatch_get_main_queue(), ^{
        [CameraOffloadBridge scanDocumentWithHostDir:hostDir guestDir:guestDir
                                          completion:^(NSDictionary *data, NSString *error) {
            result = data;
            errorMsg = error;
            dispatch_semaphore_signal(sem);
        }];
    });
    return wait_and_emit(@"scan-document", sem, &result, &errorMsg, stdout_fd, compact, quiet);
}

static int cmd_status(int stdout_fd, BOOL compact, BOOL quiet) {
    __block NSString *auth = nil;
    noff_dispatch_main_sync(^id{
        auth = (NSString *)[CameraOffloadBridge authStatus];
        return nil;
    });
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"status", @{
        @"authorization": auth ?: @"unknown",
        @"camera_available": @([UIImagePickerController isSourceTypeAvailable:UIImagePickerControllerSourceTypeCamera]),
    }), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static int camera_handler(int argc, char **argv,
                          int stdin_fd, int stdout_fd, int stderr_fd) {
    if (noff_has_flag(argc, argv, "--help") || noff_has_flag(argc, argv, "-h")) {
        noff_emit_help(stderr_fd, HELP_TEXT);
        return NOFF_EXIT_SUCCESS;
    }
    BOOL compact = noff_has_flag(argc, argv, "--compact");
    BOOL quiet = noff_has_flag(argc, argv, "-q") || noff_has_flag(argc, argv, "--quiet");

    NSString *subcmd = noff_get_subcommand(argc, argv);
    if (!subcmd) {
        noff_emit_help(stderr_fd, HELP_TEXT);
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"unknown", NOFF_ERR_INVALID_ARGS,
                       @"No command specified. Use --help for usage."), compact, quiet);
        return NOFF_EXIT_INVALID_ARGS;
    }

    @autoreleasepool {
        if ([subcmd isEqualToString:@"photo"])         return cmd_photo(argc, argv, stdout_fd, compact, quiet);
        if ([subcmd isEqualToString:@"scan-code"])     return cmd_scan_code(stdout_fd, compact, quiet);
        if ([subcmd isEqualToString:@"scan-document"]) return cmd_scan_document(stdout_fd, compact, quiet);
        if ([subcmd isEqualToString:@"status"])        return cmd_status(stdout_fd, compact, quiet);
    }

    noff_emit_help(stderr_fd, HELP_TEXT);
    noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, subcmd, NOFF_ERR_INVALID_ARGS,
                   [NSString stringWithFormat:@"Unknown command '%@'. Valid: photo, scan-code, scan-document, status.", subcmd]),
                   compact, quiet);
    return NOFF_EXIT_INVALID_ARGS;
}

void camera_offload_register(void) {
    int err = native_offload_add_handler("apple-camera", camera_handler);
    if (err == 0) {
        noff_ensure_guest_stub("/usr/local/bin/apple-camera");
        NSLog(@"NativeOffloads: apple-camera handler registered");
    } else {
        NSLog(@"NativeOffloads: failed to register apple-camera handler (err=%d)", err);
    }
}
