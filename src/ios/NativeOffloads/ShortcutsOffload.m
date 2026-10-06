//
//  ShortcutsOffload.m
//  MinisApp
//
//  Native offload handler for `apple-shortcuts`.
//  Subcommands: run, open, list, register, unregister
//
//  规格书 E·P0「快捷指令运行器」:iOS 没有公开 API 枚举用户的快捷指令库,
//  也不能后台静默运行第三方动作——能做的是 shortcuts://x-callback-url 封装。
//  run 会把前台切到快捷指令 App 执行,用户全程可见;x-success/x-error 指回
//  leophoneagent://shortcut-result?run=<runId> 让执行完自动跳回本 App,并把
//  快捷指令的输出带回来(见 ShortcutCallbackStore.swift,[C1])。登记表(register/list)解决
//  「模型不知道用户有哪些快捷指令」:用户报一次名字,以后模型直接可用。
//  这一条打开整个 E 级间接能力面(Apple Notes、系统设置、第三方 App 动作)。
//

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import "NativeOffloadUtils.h"
#include "kernel/native_offload.h"
#import "LeoPhoneAgent-Swift.h"

static NSString *const TOOL_NAME = @"apple-shortcuts";
static NSString *const REGISTRY_KEY = @"appleShortcuts.registry";

static NSString *const HELP_TEXT =
    @"apple-shortcuts - Run user Shortcuts via x-callback-url\n"
     "\n"
     "USAGE:\n"
     "  apple-shortcuts <command> [options]\n"
     "\n"
     "COMMANDS:\n"
     "  run         Run a shortcut by name and wait for its output (switches to the Shortcuts app)\n"
     "  open        Open a shortcut in the Shortcuts editor\n"
     "  list        List shortcuts the user has registered here\n"
     "  register    Remember a shortcut name for later runs\n"
     "  unregister  Forget a registered shortcut\n"
     "\n"
     "COMMON OPTIONS:\n"
     "  --help, -h           Show this help message\n"
     "  --compact            Minimize JSON output\n"
     "  -q, --quiet          Output only data field\n"
     "\n"
     "RUN OPTIONS:\n"
     "  --name <name>        Shortcut name (exact, as shown in Shortcuts app)\n"
     "  --input <text>       Pass text as the shortcut's input\n"
     "  --input-file <path>  Pass a file's text content as input (max 16KB)\n"
     "  --timeout <sec>      How long to wait for the result (default 60, 5-300)\n"
     "  --no-return          Don't bounce back or wait for output; just launch it\n"
     "\n"
     "REGISTER OPTIONS:\n"
     "  --name <name>        Shortcut name (required)\n"
     "  --desc <text>        What this shortcut does (helps the AI pick it)\n"
     "\n"
     "EXAMPLES:\n"
     "  apple-shortcuts run --name \"Good Morning\"\n"
     "  apple-shortcuts run --name \"Append To Notes\" --input \"buy milk\"\n"
     "  apple-shortcuts register --name \"Append To Notes\" --desc \"Adds text to my daily note\"\n"
     "  apple-shortcuts list\n"
     "\n"
     "RESULTS:\n"
     "  run waits (by run_id) until the shortcut calls back, then returns its output:\n"
     "  1. If the Shortcuts app passes the shortcut's output on x-success, it is\n"
     "     returned as `output` (output_source=callback).\n"
     "  2. Otherwise end the shortcut with \"Save File\" (Ask Where to Save: off,\n"
     "     Overwrite: on) to Files > LeoBot > shared > ShortcutResults/<name>.txt\n"
     "     (or <run_id>.txt). It is read when the callback arrives or when\n"
     "     LeoBot returns to the foreground (output_source=file).\n"
     "  No callback within the timeout -> status=timeout (the shortcut may still run).\n"
     "\n"
     "NOTE: iOS provides no API to enumerate the user's shortcuts library.\n"
     "Ask the user for the exact shortcut name, then `register` it so it\n"
     "shows up in `list` next time. Running a shortcut brings the Shortcuts\n"
     "app to the foreground; the user sees and controls every step.\n";

// ── Registry (NSUserDefaults-backed, tiny) ──

static NSArray<NSDictionary *> *registry_load(void) {
    NSArray *stored = [[NSUserDefaults standardUserDefaults] arrayForKey:REGISTRY_KEY];
    return stored ?: @[];
}

static void registry_save(NSArray<NSDictionary *> *entries) {
    [[NSUserDefaults standardUserDefaults] setObject:entries forKey:REGISTRY_KEY];
}

// ── Subcommands ──

static int cmd_list(int stdout_fd, BOOL compact, BOOL quiet) {
    NSArray *entries = registry_load();
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"list", @{
        @"shortcuts": entries,
        @"count": @(entries.count),
        @"note": @"iOS cannot enumerate the Shortcuts library. This list only contains "
                  "shortcuts registered here. Ask the user for exact names of others.",
    }), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static int cmd_register(int argc, char **argv, int stdout_fd, BOOL compact, BOOL quiet) {
    NSString *name = noff_find_arg(argc, argv, "--name");
    if (name.length == 0) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"register", NOFF_ERR_INVALID_ARGS,
                       @"--name is required"), compact, quiet);
        return NOFF_EXIT_INVALID_ARGS;
    }
    NSString *desc = noff_find_arg(argc, argv, "--desc") ?: @"";
    NSMutableArray *entries = [registry_load() mutableCopy];
    // Same name replaces the old entry (update the description in place).
    NSUInteger existing = [entries indexOfObjectPassingTest:^BOOL(NSDictionary *e, NSUInteger i, BOOL *stop) {
        return [e[@"name"] isEqualToString:name];
    }];
    NSDictionary *entry = @{@"name": name, @"desc": desc,
                            @"registered_at": noff_format_date([NSDate date])};
    if (existing != NSNotFound) {
        entries[existing] = entry;
    } else {
        [entries addObject:entry];
    }
    registry_save(entries);
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"register", @{
        @"registered": entry, @"count": @(entries.count),
    }), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static int cmd_unregister(int argc, char **argv, int stdout_fd, BOOL compact, BOOL quiet) {
    NSString *name = noff_find_arg(argc, argv, "--name");
    if (name.length == 0) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"unregister", NOFF_ERR_INVALID_ARGS,
                       @"--name is required"), compact, quiet);
        return NOFF_EXIT_INVALID_ARGS;
    }
    NSMutableArray *entries = [registry_load() mutableCopy];
    NSUInteger before = entries.count;
    [entries filterUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDictionary *e, NSDictionary *bindings) {
        return ![e[@"name"] isEqualToString:name];
    }]];
    if (entries.count == before) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"unregister", NOFF_ERR_NO_DATA,
                       [NSString stringWithFormat:@"No registered shortcut named '%@'", name]), compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    registry_save(entries);
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"unregister", @{
        @"removed": name, @"count": @(entries.count),
    }), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

/// Open a URL on the main thread; returns whether iOS accepted it.
static BOOL open_url_sync(NSURL *url, UIApplicationState *stateOut) {
    __block BOOL opened = NO;
    __block UIApplicationState appState = UIApplicationStateActive;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_main_queue(), ^{
        appState = UIApplication.sharedApplication.applicationState;
        [UIApplication.sharedApplication openURL:url options:@{}
                               completionHandler:^(BOOL success) {
            opened = success;
            dispatch_semaphore_signal(sem);
        }];
    });
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));
    if (stateOut) *stateOut = appState;
    return opened;
}

static int emit_open_failure(NSString *action, UIApplicationState appState, int stdout_fd,
                             BOOL compact, BOOL quiet) {
    NSString *hint = appState == UIApplicationStateActive
        ? @"iOS declined to open the Shortcuts URL. Is the Shortcuts app installed?"
        : @"iOS declined to open the Shortcuts URL — LeoBot is in the background. "
           "Ask the user to bring LeoBot to the foreground and retry.";
    noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, action, NOFF_ERR_NOT_AVAILABLE, hint),
                   compact, quiet);
    return NOFF_EXIT_NOT_AVAILABLE;
}

/// Open a shortcuts:// URL on the main thread and report whether iOS accepted it.
static int open_shortcuts_url(NSURL *url, NSString *action, int stdout_fd,
                              NSDictionary *extraData, BOOL compact, BOOL quiet) {
    UIApplicationState appState = UIApplicationStateActive;
    BOOL opened = open_url_sync(url, &appState);

    if (!opened) {
        return emit_open_failure(action, appState, stdout_fd, compact, quiet);
    }

    NSMutableDictionary *data = [NSMutableDictionary dictionaryWithDictionary:extraData ?: @{}];
    data[@"launched"] = @YES;
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, action, data), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static int cmd_run(int argc, char **argv, int stdout_fd, int stderr_fd, BOOL compact, BOOL quiet) {
    NSString *name = noff_find_arg(argc, argv, "--name");
    if (name.length == 0) {
        // Allow `apple-shortcuts run "My Shortcut"` positional form too.
        NSArray *positional = noff_positional_args(argc, argv);
        if (positional.count > 0) name = positional[0];
    }
    if (name.length == 0) {
        noff_emit_help(stderr_fd, HELP_TEXT);
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"run", NOFF_ERR_INVALID_ARGS,
                       @"--name <shortcut name> is required"), compact, quiet);
        return NOFF_EXIT_INVALID_ARGS;
    }

    NSString *inputText = noff_find_arg(argc, argv, "--input");
    NSString *inputFile = noff_find_arg(argc, argv, "--input-file");
    if (inputText == nil && inputFile.length > 0) {
        NSString *hostPath = [inputFile hasPrefix:@"/"] ? noff_resolve_host_path(inputFile) : inputFile;
        NSData *fileData = hostPath ? [NSData dataWithContentsOfFile:hostPath] : nil;
        if (!fileData) {
            noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"run", NOFF_ERR_INVALID_ARGS,
                           [NSString stringWithFormat:@"Cannot read --input-file: %@", inputFile]), compact, quiet);
            return NOFF_EXIT_INVALID_ARGS;
        }
        // URL 长度有限,截 16KB 足够传文本参数;更大的内容让快捷指令自己去
        // 共享目录里拿(File Provider 已把 /var/minis 暴露给"文件"App)。
        if (fileData.length > 16 * 1024) fileData = [fileData subdataWithRange:NSMakeRange(0, 16 * 1024)];
        inputText = [[NSString alloc] initWithData:fileData encoding:NSUTF8StringEncoding];
        if (!inputText) {
            noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"run", NOFF_ERR_INVALID_ARGS,
                           @"--input-file is not UTF-8 text"), compact, quiet);
            return NOFF_EXIT_INVALID_ARGS;
        }
    }

    NSURLComponents *components = [NSURLComponents componentsWithString:@"shortcuts://x-callback-url/run-shortcut"];
    NSMutableArray<NSURLQueryItem *> *items = [NSMutableArray array];
    [items addObject:[NSURLQueryItem queryItemWithName:@"name" value:name]];
    if (inputText.length > 0) {
        [items addObject:[NSURLQueryItem queryItemWithName:@"input" value:@"text"]];
        [items addObject:[NSURLQueryItem queryItemWithName:@"text" value:inputText]];
    }
    if (noff_has_flag(argc, argv, "--no-return")) {
        components.queryItems = items;
        return open_shortcuts_url(components.URL, @"run", stdout_fd, @{
            @"name": name,
            @"input_passed": @(inputText.length > 0),
            @"note": @"Launched without waiting (--no-return); no output is collected.",
        }, compact, quiet);
    }

    // [C1] 每次运行一个 runId;回调带回结果,否则读 ShortcutResults 里的结果文件。
    NSTimeInterval timeout = 60;
    NSString *timeoutArg = noff_find_arg(argc, argv, "--timeout");
    if (timeoutArg.length > 0) timeout = MAX(5, MIN(300, timeoutArg.doubleValue));
    NSString *runId = [LeoShortcutCallbackStore beginRunWithName:name];
    [items addObject:[NSURLQueryItem queryItemWithName:@"x-success"
                      value:[LeoShortcutCallbackStore callbackURLStringWithRunId:runId status:@"success"]]];
    [items addObject:[NSURLQueryItem queryItemWithName:@"x-error"
                      value:[LeoShortcutCallbackStore callbackURLStringWithRunId:runId status:@"error"]]];
    [items addObject:[NSURLQueryItem queryItemWithName:@"x-cancel"
                      value:[LeoShortcutCallbackStore callbackURLStringWithRunId:runId status:@"cancel"]]];
    components.queryItems = items;

    UIApplicationState appState = UIApplicationStateActive;
    if (!open_url_sync(components.URL, &appState)) {
        [LeoShortcutCallbackStore cancelRun:runId];
        return emit_open_failure(@"run", appState, stdout_fd, compact, quiet);
    }

    NSDate *started = [NSDate date];
    NSDictionary *outcome = [LeoShortcutCallbackStore waitForRun:runId timeout:timeout];
    NSString *status = outcome[@"status"] ?: @"timeout";
    NSMutableDictionary *data = [NSMutableDictionary dictionaryWithDictionary:@{
        @"name": name,
        @"run_id": runId,
        @"input_passed": @(inputText.length > 0),
        @"status": status,
        @"elapsed_ms": @((NSInteger)([[NSDate date] timeIntervalSinceDate:started] * 1000)),
    }];
    if ([status isEqualToString:@"error"] || [status isEqualToString:@"cancel"]) {
        NSString *message = [status isEqualToString:@"cancel"]
            ? [NSString stringWithFormat:@"Shortcut '%@' was cancelled.", name]
            : [NSString stringWithFormat:@"Shortcut '%@' failed: %@", name, outcome[@"error"] ?: @"unknown error"];
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"run", NOFF_ERR_INTERNAL_ERROR, message), compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    if (outcome[@"output"]) {
        data[@"output"] = outcome[@"output"];
        data[@"output_source"] = outcome[@"source"] ?: @"callback";
    } else if ([status isEqualToString:@"success"]) {
        data[@"output"] = [NSNull null];
        data[@"note"] = [NSString stringWithFormat:
            @"The shortcut finished but returned no text. To get its output, end the shortcut with "
             "'Save File' to Files > LeoBot > shared > ShortcutResults/%@.txt.", name];
    } else {
        data[@"note"] = [NSString stringWithFormat:
            @"No callback within %.0f s; the shortcut may still be running. If it saves "
             "ShortcutResults/%@.txt, read it from /var/minis/shared/ShortcutResults/ later.", timeout, name];
    }
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"run", data), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static int cmd_open(int argc, char **argv, int stdout_fd, int stderr_fd, BOOL compact, BOOL quiet) {
    NSString *name = noff_find_arg(argc, argv, "--name");
    if (name.length == 0) {
        NSArray *positional = noff_positional_args(argc, argv);
        if (positional.count > 0) name = positional[0];
    }
    if (name.length == 0) {
        noff_emit_help(stderr_fd, HELP_TEXT);
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"open", NOFF_ERR_INVALID_ARGS,
                       @"--name <shortcut name> is required"), compact, quiet);
        return NOFF_EXIT_INVALID_ARGS;
    }
    NSURLComponents *components = [NSURLComponents componentsWithString:@"shortcuts://open-shortcut"];
    components.queryItems = @[[NSURLQueryItem queryItemWithName:@"name" value:name]];
    return open_shortcuts_url(components.URL, @"open", stdout_fd, @{@"name": name}, compact, quiet);
}

static int shortcuts_handler(int argc, char **argv,
                             int stdin_fd, int stdout_fd, int stderr_fd) {
    if (noff_has_flag(argc, argv, "--help") || noff_has_flag(argc, argv, "-h")) {
        noff_emit_help(stderr_fd, HELP_TEXT);
        return NOFF_EXIT_SUCCESS;
    }
    BOOL compact = noff_has_flag(argc, argv, "--compact");
    BOOL quiet = noff_has_flag(argc, argv, "-q") || noff_has_flag(argc, argv, "--quiet");

    NSString *subcmd = noff_get_subcommand(argc, argv);
    if (!subcmd) {
        return cmd_list(stdout_fd, compact, quiet);
    }

    @autoreleasepool {
        if ([subcmd isEqualToString:@"list"])       return cmd_list(stdout_fd, compact, quiet);
        if ([subcmd isEqualToString:@"run"])        return cmd_run(argc, argv, stdout_fd, stderr_fd, compact, quiet);
        if ([subcmd isEqualToString:@"open"])       return cmd_open(argc, argv, stdout_fd, stderr_fd, compact, quiet);
        if ([subcmd isEqualToString:@"register"])   return cmd_register(argc, argv, stdout_fd, compact, quiet);
        if ([subcmd isEqualToString:@"unregister"]) return cmd_unregister(argc, argv, stdout_fd, compact, quiet);
    }

    noff_emit_help(stderr_fd, HELP_TEXT);
    noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, subcmd, NOFF_ERR_INVALID_ARGS,
                   [NSString stringWithFormat:@"Unknown command '%@'. Valid: run, open, list, register, unregister.", subcmd]),
                   compact, quiet);
    return NOFF_EXIT_INVALID_ARGS;
}

void shortcuts_offload_register(void) {
    int err = native_offload_add_handler("apple-shortcuts", shortcuts_handler);
    if (err == 0) {
        noff_ensure_guest_stub("/usr/local/bin/apple-shortcuts");
        NSLog(@"NativeOffloads: apple-shortcuts handler registered");
    } else {
        NSLog(@"NativeOffloads: failed to register apple-shortcuts handler (err=%d)", err);
    }
}
