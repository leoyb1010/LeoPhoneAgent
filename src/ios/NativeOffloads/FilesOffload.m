//
//  FilesOffload.m
//  MinisApp
//
//  Native offload handler for `apple-files`.
//  Subcommands: list, request, pick, reauth, remove
//
//  规格书 B·P0「文件与文档」:Document Picker / 文件夹授权 / 失效 bookmark
//  处理。所有授权动作都弹系统选择器由用户亲手完成——Agent 发起请求,
//  用户决定给什么。授权结果落在 MountedFoldersManager(security-scoped
//  bookmark,App 重启后仍有效),挂载进 /var/minis/mounts/<name> 供 shell 读写。
//

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import "NativeOffloadUtils.h"
#include "kernel/native_offload.h"

#import "LeoPhoneAgent-Swift.h"

static NSString *const TOOL_NAME = @"apple-files";

static NSString *const HELP_TEXT =
    @"apple-files - External folder grants and file pickers\n"
     "\n"
     "USAGE:\n"
     "  apple-files <command> [options]\n"
     "\n"
     "COMMANDS:\n"
     "  list       List folders the user has granted (default)\n"
     "  request    Ask the user to grant a folder (opens folder picker)\n"
     "  pick       Ask the user to pick file(s); copies into /var/minis/offloads/\n"
     "  reauth     Re-resolve a mount whose grant went stale\n"
     "  remove     Remove a granted folder (requires --confirm)\n"
     "\n"
     "COMMON OPTIONS:\n"
     "  --help, -h           Show this help message\n"
     "  --compact            Minimize JSON output\n"
     "  -q, --quiet          Output only data field\n"
     "\n"
     "REQUEST OPTIONS:\n"
     "  --name <name>        Mount name under /var/minis/mounts/ (default: folder name)\n"
     "  --read-only          Mount without write access\n"
     "\n"
     "PICK OPTIONS:\n"
     "  --multiple           Allow selecting more than one file\n"
     "\n"
     "REAUTH / REMOVE OPTIONS:\n"
     "  --name <name>        Mount name from `list`\n"
     "  --confirm            Required for remove\n"
     "\n"
     "EXAMPLES:\n"
     "  apple-files list\n"
     "  apple-files request --name notes\n"
     "  apple-files pick --multiple\n"
     "  apple-files reauth --name notes\n"
     "  apple-files remove --name notes --confirm\n"
     "\n"
     "NOTE: request/pick present a system picker — the app must be in the\n"
     "foreground and the user completes the selection. Granted folders appear\n"
     "under /var/minis/mounts/<name>/ for shell access.\n";

static int cmd_list(int stdout_fd, BOOL compact, BOOL quiet) {
    __block NSArray *mounts = nil;
    noff_dispatch_main_sync(^id{
        mounts = [FilesOffloadBridge listMounts];
        return nil;
    });
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"list", @{
        @"mounts": mounts ?: @[],
        @"count": @(mounts.count),
        @"hint": @"Use `apple-files request` to ask the user for another folder.",
    }), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static int cmd_request(int argc, char **argv, int stdout_fd, BOOL compact, BOOL quiet) {
    NSString *name = noff_find_arg(argc, argv, "--name");
    BOOL readOnly = noff_has_flag(argc, argv, "--read-only");

    __block NSDictionary *result = nil;
    __block NSString *errorMsg = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);

    dispatch_async(dispatch_get_main_queue(), ^{
        [FilesOffloadBridge requestFolderWithName:name readOnly:readOnly
                                       completion:^(NSDictionary *data, NSString *error) {
            result = data;
            errorMsg = error;
            dispatch_semaphore_signal(sem);
        }];
    });

    // 用户在系统选择器里操作,给足时间;guest 进程被 kill 时可协作取消。
    long waitResult = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_SEC));
    if (waitResult != 0) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"request", NOFF_ERR_INTERNAL_ERROR,
                       @"Timed out waiting for the folder picker."), compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    if (errorMsg) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"request", NOFF_ERR_NO_DATA, errorMsg),
                       compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"request", result ?: @{}), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static int cmd_pick(int argc, char **argv, int stdout_fd, BOOL compact, BOOL quiet) {
    BOOL multiple = noff_has_flag(argc, argv, "--multiple");
    NSString *guestDir = @"/var/minis/offloads";
    NSString *hostDir = noff_resolve_host_path(guestDir);

    __block NSDictionary *result = nil;
    __block NSString *errorMsg = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);

    dispatch_async(dispatch_get_main_queue(), ^{
        [FilesOffloadBridge pickFilesWithMultiple:multiple hostDir:hostDir guestDir:guestDir
                                       completion:^(NSDictionary *data, NSString *error) {
            result = data;
            errorMsg = error;
            dispatch_semaphore_signal(sem);
        }];
    });

    long waitResult = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_SEC));
    if (waitResult != 0) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"pick", NOFF_ERR_INTERNAL_ERROR,
                       @"Timed out waiting for the file picker."), compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    if (errorMsg) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"pick", NOFF_ERR_NO_DATA, errorMsg),
                       compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"pick", result ?: @{}), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static int cmd_reauth(int argc, char **argv, int stdout_fd, BOOL compact, BOOL quiet) {
    NSString *name = noff_find_arg(argc, argv, "--name");
    if (name.length == 0) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"reauth", NOFF_ERR_INVALID_ARGS,
                       @"--name is required (see `apple-files list`)"), compact, quiet);
        return NOFF_EXIT_INVALID_ARGS;
    }
    __block NSDictionary *result = nil;
    noff_dispatch_main_sync(^id{
        result = [FilesOffloadBridge reauthMount:name];
        return nil;
    });
    if (result[@"error"]) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"reauth", NOFF_ERR_NO_DATA,
                       result[@"error"]), compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"reauth", result), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static int cmd_remove(int argc, char **argv, int stdout_fd, BOOL compact, BOOL quiet) {
    NSString *name = noff_find_arg(argc, argv, "--name");
    if (name.length == 0) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"remove", NOFF_ERR_INVALID_ARGS,
                       @"--name is required (see `apple-files list`)"), compact, quiet);
        return NOFF_EXIT_INVALID_ARGS;
    }
    // 撤销授权改变用户已建立的工作环境:必须显式确认。
    if (!noff_has_flag(argc, argv, "--confirm")) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"remove", NOFF_ERR_INVALID_ARGS,
                       @"Removing a folder grant requires --confirm after the user has agreed."), compact, quiet);
        return NOFF_EXIT_INVALID_ARGS;
    }
    __block NSDictionary *result = nil;
    noff_dispatch_main_sync(^id{
        result = [FilesOffloadBridge removeMount:name];
        return nil;
    });
    if (result[@"error"]) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"remove", NOFF_ERR_NO_DATA,
                       result[@"error"]), compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"remove", result), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static int files_handler(int argc, char **argv,
                         int stdin_fd, int stdout_fd, int stderr_fd) {
    if (noff_has_flag(argc, argv, "--help") || noff_has_flag(argc, argv, "-h")) {
        noff_emit_help(stderr_fd, HELP_TEXT);
        return NOFF_EXIT_SUCCESS;
    }
    BOOL compact = noff_has_flag(argc, argv, "--compact");
    BOOL quiet = noff_has_flag(argc, argv, "-q") || noff_has_flag(argc, argv, "--quiet");

    NSString *subcmd = noff_get_subcommand(argc, argv) ?: @"list";

    @autoreleasepool {
        if ([subcmd isEqualToString:@"list"])    return cmd_list(stdout_fd, compact, quiet);
        if ([subcmd isEqualToString:@"request"]) return cmd_request(argc, argv, stdout_fd, compact, quiet);
        if ([subcmd isEqualToString:@"pick"])    return cmd_pick(argc, argv, stdout_fd, compact, quiet);
        if ([subcmd isEqualToString:@"reauth"])  return cmd_reauth(argc, argv, stdout_fd, compact, quiet);
        if ([subcmd isEqualToString:@"remove"])  return cmd_remove(argc, argv, stdout_fd, compact, quiet);
    }

    noff_emit_help(stderr_fd, HELP_TEXT);
    noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, subcmd, NOFF_ERR_INVALID_ARGS,
                   [NSString stringWithFormat:@"Unknown command '%@'. Valid: list, request, pick, reauth, remove.", subcmd]),
                   compact, quiet);
    return NOFF_EXIT_INVALID_ARGS;
}

void files_offload_register(void) {
    int err = native_offload_add_handler("apple-files", files_handler);
    if (err == 0) {
        noff_ensure_guest_stub("/usr/local/bin/apple-files");
        NSLog(@"NativeOffloads: apple-files handler registered");
    } else {
        NSLog(@"NativeOffloads: failed to register apple-files handler (err=%d)", err);
    }
}
