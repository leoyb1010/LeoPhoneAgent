//
//  ContactsOffload.m
//  MinisApp
//
//  Native offload handler for `apple-contacts`.
//  Subcommands: list, search, get, groups, create, update, delete, status
//
//  规格书 §「联系人与通信」B·P0:全矩阵里最大的缺口——补上之前,Agent 连
//  「给某人打电话」都要用户自己报号码。读走 CNContactStore,写操作(create/
//  update/delete)一律要求 --confirm 显式确认,与规格书 §6「删除、发送、
//  批量修改必须在执行前明确确认」一致;拨号/短信/邮件仍交给 apple-open,
//  由系统 App 做最终发送确认(我们只预填,绝不绕过)。
//

#import <Foundation/Foundation.h>
#import <Contacts/Contacts.h>
#import "NativeOffloadUtils.h"
#include "kernel/native_offload.h"

static NSString *const TOOL_NAME = @"apple-contacts";

static NSString *const HELP_TEXT =
    @"apple-contacts - Query and manage iOS contacts\n"
     "\n"
     "USAGE:\n"
     "  apple-contacts <command> [options]\n"
     "\n"
     "COMMANDS:\n"
     "  list        List contacts (use --limit to page)\n"
     "  search      Search contacts by name, phone, email or organization\n"
     "  get         Get one contact in full detail\n"
     "  groups      List contact groups\n"
     "  create      Create a contact (requires --confirm)\n"
     "  update      Update a contact (requires --confirm)\n"
     "  delete      Delete a contact (requires --confirm)\n"
     "  status      Show authorization status without prompting\n"
     "\n"
     "COMMON OPTIONS:\n"
     "  --help, -h           Show this help message\n"
     "  --compact            Minimize JSON output\n"
     "  -q, --quiet          Output only data field\n"
     "\n"
     "LIST / SEARCH OPTIONS:\n"
     "  --query <text>       Search text (search only, required)\n"
     "  --limit <N>          Maximum results (default 50)\n"
     "  --group <name>       Only contacts in this group\n"
     "\n"
     "GET OPTIONS:\n"
     "  --id <contact_id>    Contact identifier from list/search output\n"
     "\n"
     "CREATE OPTIONS (--confirm required):\n"
     "  --first <name>       Given name\n"
     "  --last <name>        Family name\n"
     "  --org <name>         Organization\n"
     "  --phone <number>     Phone number (repeatable)\n"
     "  --email <address>    Email address (repeatable)\n"
     "  --note <text>        Note (needs com.apple.developer.contacts.notes)\n"
     "\n"
     "UPDATE OPTIONS (--confirm required):\n"
     "  --id <contact_id>    Contact to update (required)\n"
     "  --first/--last/--org/--phone/--email as above (replaces the field)\n"
     "\n"
     "DELETE OPTIONS (--confirm required):\n"
     "  --id <contact_id>    Contact to delete (required)\n"
     "\n"
     "EXAMPLES:\n"
     "  apple-contacts status\n"
     "  apple-contacts search --query 张伟\n"
     "  apple-contacts search --query 13800 --limit 5\n"
     "  apple-contacts get --id <contact_id>\n"
     "  apple-contacts create --first 伟 --last 张 --phone 13800138000 --confirm\n"
     "  apple-contacts update --id <contact_id> --email new@example.com --confirm\n"
     "  apple-contacts delete --id <contact_id> --confirm\n"
     "\n"
     "NOTE: to actually call/message someone, pass the number to apple-open:\n"
     "  apple-open \"tel:13800138000\"     apple-open \"sms:13800138000\"\n";

// 读取用的 key 集合。notes 需要 Apple 特批 entitlement,不在默认集合里
// (放进去会让整次 fetch 直接抛异常)。
static NSArray *contact_fetch_keys(void) {
    return @[
        CNContactIdentifierKey,
        CNContactGivenNameKey, CNContactFamilyNameKey, CNContactMiddleNameKey,
        CNContactNicknameKey, CNContactOrganizationNameKey, CNContactJobTitleKey,
        CNContactPhoneNumbersKey, CNContactEmailAddressesKey,
        CNContactPostalAddressesKey, CNContactBirthdayKey,
        CNContactImageDataAvailableKey,
        [CNContactFormatter descriptorForRequiredKeysForStyle:CNContactFormatterStyleFullName],
    ];
}

static NSDictionary *contact_to_dict(CNContact *contact, BOOL full) {
    NSMutableDictionary *dict = [NSMutableDictionary dictionary];
    dict[@"id"] = contact.identifier;
    NSString *display = [CNContactFormatter stringFromContact:contact style:CNContactFormatterStyleFullName];
    dict[@"name"] = display.length > 0 ? display : (contact.organizationName ?: @"");
    if (contact.givenName.length) dict[@"first_name"] = contact.givenName;
    if (contact.familyName.length) dict[@"last_name"] = contact.familyName;
    if (contact.organizationName.length) dict[@"organization"] = contact.organizationName;

    NSMutableArray *phones = [NSMutableArray array];
    for (CNLabeledValue<CNPhoneNumber *> *item in contact.phoneNumbers) {
        [phones addObject:@{
            @"label": item.label ? [CNLabeledValue localizedStringForLabel:item.label] : @"",
            @"value": item.value.stringValue ?: @"",
        }];
    }
    if (phones.count) dict[@"phones"] = phones;

    NSMutableArray *emails = [NSMutableArray array];
    for (CNLabeledValue<NSString *> *item in contact.emailAddresses) {
        [emails addObject:@{
            @"label": item.label ? [CNLabeledValue localizedStringForLabel:item.label] : @"",
            @"value": item.value ?: @"",
        }];
    }
    if (emails.count) dict[@"emails"] = emails;

    if (!full) return dict;

    if (contact.middleName.length) dict[@"middle_name"] = contact.middleName;
    if (contact.nickname.length) dict[@"nickname"] = contact.nickname;
    if (contact.jobTitle.length) dict[@"job_title"] = contact.jobTitle;
    dict[@"has_image"] = @(contact.imageDataAvailable);

    NSMutableArray *addresses = [NSMutableArray array];
    for (CNLabeledValue<CNPostalAddress *> *item in contact.postalAddresses) {
        CNPostalAddress *addr = item.value;
        [addresses addObject:@{
            @"label": item.label ? [CNLabeledValue localizedStringForLabel:item.label] : @"",
            @"street": addr.street ?: @"", @"city": addr.city ?: @"",
            @"state": addr.state ?: @"", @"postal_code": addr.postalCode ?: @"",
            @"country": addr.country ?: @"",
        }];
    }
    if (addresses.count) dict[@"addresses"] = addresses;

    if (contact.birthday) {
        NSDateComponents *bd = contact.birthday;
        dict[@"birthday"] = bd.year != NSDateComponentUndefined
            ? [NSString stringWithFormat:@"%ld-%02ld-%02ld", (long)bd.year, (long)bd.month, (long)bd.day]
            : [NSString stringWithFormat:@"--%02ld-%02ld", (long)bd.month, (long)bd.day];
    }
    return dict;
}

/// 授权:未决定时请求一次并等待(与 location/calendar 同样的同步等待模式)。
/// 返回 nil 表示已授权;否则返回可直接输出的错误信封。
static NSDictionary *ensure_authorized(NSString *action) {
    CNAuthorizationStatus status = [CNContactStore authorizationStatusForEntityType:CNEntityTypeContacts];
    if (status == CNAuthorizationStatusNotDetermined) {
        CNContactStore *store = [[CNContactStore alloc] init];
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        __block BOOL granted = NO;
        [store requestAccessForEntityType:CNEntityTypeContacts
                        completionHandler:^(BOOL ok, NSError *error) {
            granted = ok;
            dispatch_semaphore_signal(sem);
        }];
        dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC));
        if (!granted) {
            return noff_json_error(TOOL_NAME, action, NOFF_ERR_AUTHORIZATION_DENIED,
                                   @"Contacts access was denied. Enable it in 设置 → 隐私与安全性 → 通讯录.");
        }
        return nil;
    }
    // iOS 18 起有「受限访问」:能读到用户挑选的那部分,按已授权处理。
    if (status == CNAuthorizationStatusAuthorized) return nil;
    if (@available(iOS 18.0, *)) {
        if (status == CNAuthorizationStatusLimited) return nil;
    }
    return noff_json_error(TOOL_NAME, action, NOFF_ERR_AUTHORIZATION_DENIED,
                           @"Contacts access is not granted. Enable it in 设置 → 隐私与安全性 → 通讯录.");
}

static int cmd_status(int stdout_fd, BOOL compact, BOOL quiet) {
    CNAuthorizationStatus status = [CNContactStore authorizationStatusForEntityType:CNEntityTypeContacts];
    NSString *name = @"unknown";
    switch (status) {
        case CNAuthorizationStatusNotDetermined: name = @"not_determined"; break;
        case CNAuthorizationStatusRestricted:    name = @"restricted"; break;
        case CNAuthorizationStatusDenied:        name = @"denied"; break;
        case CNAuthorizationStatusAuthorized:    name = @"authorized"; break;
        default:
            if (@available(iOS 18.0, *)) {
                if (status == CNAuthorizationStatusLimited) name = @"limited";
            }
            break;
    }
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"status",
                   @{@"authorization": name}), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static BOOL contact_matches(CNContact *contact, NSString *needle) {
    NSString *lower = needle.lowercaseString;
    NSString *display = [CNContactFormatter stringFromContact:contact style:CNContactFormatterStyleFullName] ?: @"";
    if ([display.lowercaseString containsString:lower]) return YES;
    if ([contact.organizationName.lowercaseString containsString:lower]) return YES;
    if ([contact.nickname.lowercaseString containsString:lower]) return YES;
    for (CNLabeledValue<CNPhoneNumber *> *item in contact.phoneNumbers) {
        NSString *digits = [[item.value.stringValue componentsSeparatedByCharactersInSet:
                             [[NSCharacterSet decimalDigitCharacterSet] invertedSet]]
                            componentsJoinedByString:@""];
        NSString *needleDigits = [[needle componentsSeparatedByCharactersInSet:
                                   [[NSCharacterSet decimalDigitCharacterSet] invertedSet]]
                                  componentsJoinedByString:@""];
        if (needleDigits.length > 0 && [digits containsString:needleDigits]) return YES;
    }
    for (CNLabeledValue<NSString *> *item in contact.emailAddresses) {
        if ([item.value.lowercaseString containsString:lower]) return YES;
    }
    return NO;
}

static int cmd_list_or_search(int argc, char **argv, int stdout_fd,
                              BOOL compact, BOOL quiet, BOOL isSearch) {
    NSString *action = isSearch ? @"search" : @"list";
    NSDictionary *authError = ensure_authorized(action);
    if (authError) {
        noff_emit_json(stdout_fd, authError, compact, quiet);
        return NOFF_EXIT_AUTH_DENIED;
    }
    NSString *query = noff_find_arg(argc, argv, "--query");
    if (isSearch && query.length == 0) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, action, NOFF_ERR_INVALID_ARGS,
                       @"--query is required for search"), compact, quiet);
        return NOFF_EXIT_INVALID_ARGS;
    }
    NSString *limitArg = noff_find_arg(argc, argv, "--limit");
    NSInteger limit = limitArg ? MAX(1, limitArg.integerValue) : 50;
    NSString *groupName = noff_find_arg(argc, argv, "--group");

    CNContactStore *store = [[CNContactStore alloc] init];
    NSError *error = nil;
    CNContactFetchRequest *request = [[CNContactFetchRequest alloc] initWithKeysToFetch:contact_fetch_keys()];
    request.sortOrder = CNContactSortOrderUserDefault;

    // --group:先解析成 predicate,避免全量拉取后再过滤。
    if (groupName.length) {
        NSArray<CNGroup *> *groups = [store groupsMatchingPredicate:nil error:&error];
        CNGroup *matched = nil;
        for (CNGroup *group in groups) {
            if ([group.name isEqualToString:groupName]) { matched = group; break; }
        }
        if (!matched) {
            noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, action, NOFF_ERR_NO_DATA,
                           [NSString stringWithFormat:@"No contact group named '%@'", groupName]), compact, quiet);
            return NOFF_EXIT_ERROR;
        }
        request.predicate = [CNContact predicateForContactsInGroupWithIdentifier:matched.identifier];
    }

    NSMutableArray *results = [NSMutableArray array];
    __block NSInteger scanned = 0;
    BOOL ok = [store enumerateContactsWithFetchRequest:request error:&error
                                            usingBlock:^(CNContact *contact, BOOL *stop) {
        scanned++;
        if (noff_is_cancelled()) { *stop = YES; return; }
        if (isSearch && !contact_matches(contact, query)) return;
        [results addObject:contact_to_dict(contact, NO)];
        if ((NSInteger)results.count >= limit) *stop = YES;
    }];
    if (!ok && results.count == 0) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, action, NOFF_ERR_INTERNAL_ERROR,
                       error.localizedDescription ?: @"Failed to enumerate contacts"), compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, action, @{
        @"contacts": results,
        @"count": @(results.count),
        @"scanned": @(scanned),
        @"truncated": @((NSInteger)results.count >= limit),
    }), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static int cmd_get(int argc, char **argv, int stdout_fd, BOOL compact, BOOL quiet) {
    NSDictionary *authError = ensure_authorized(@"get");
    if (authError) {
        noff_emit_json(stdout_fd, authError, compact, quiet);
        return NOFF_EXIT_AUTH_DENIED;
    }
    NSString *identifier = noff_find_arg(argc, argv, "--id");
    if (identifier.length == 0) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"get", NOFF_ERR_INVALID_ARGS,
                       @"--id is required (get it from list/search output)"), compact, quiet);
        return NOFF_EXIT_INVALID_ARGS;
    }
    CNContactStore *store = [[CNContactStore alloc] init];
    NSError *error = nil;
    CNContact *contact = [store unifiedContactWithIdentifier:identifier
                                                 keysToFetch:contact_fetch_keys()
                                                       error:&error];
    if (!contact) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"get", NOFF_ERR_NO_DATA,
                       error.localizedDescription ?: @"No such contact"), compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"get",
                   contact_to_dict(contact, YES)), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static int cmd_groups(int stdout_fd, BOOL compact, BOOL quiet) {
    NSDictionary *authError = ensure_authorized(@"groups");
    if (authError) {
        noff_emit_json(stdout_fd, authError, compact, quiet);
        return NOFF_EXIT_AUTH_DENIED;
    }
    CNContactStore *store = [[CNContactStore alloc] init];
    NSError *error = nil;
    NSArray<CNGroup *> *groups = [store groupsMatchingPredicate:nil error:&error];
    if (!groups) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"groups", NOFF_ERR_INTERNAL_ERROR,
                       error.localizedDescription ?: @"Failed to read groups"), compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    NSMutableArray *rows = [NSMutableArray array];
    for (CNGroup *group in groups) {
        [rows addObject:@{@"id": group.identifier, @"name": group.name ?: @""}];
    }
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"groups",
                   @{@"groups": rows, @"count": @(rows.count)}), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

/// 写操作的统一闸门:没有 --confirm 一律拒绝并说明。规格书 §6 要求写操作
/// 前明确确认;模型必须显式带上这个标志,不能"顺手"改用户通讯录。
static BOOL require_confirm(int argc, char **argv, int stdout_fd, NSString *action,
                            NSString *what, BOOL compact, BOOL quiet) {
    if (noff_has_flag(argc, argv, "--confirm")) return YES;
    noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, action, NOFF_ERR_INVALID_ARGS,
                   [NSString stringWithFormat:@"%@ modifies the user's contacts. Re-run with --confirm after the user has agreed.", what]),
                   compact, quiet);
    return NO;
}

/// 收集重复出现的选项值(--phone a --phone b)。
static NSArray<NSString *> *collect_repeated(int argc, char **argv, const char *name) {
    NSMutableArray *values = [NSMutableArray array];
    for (int i = 1; i < argc - 1; i++) {
        if (argv[i] && strcmp(argv[i], name) == 0 && argv[i + 1]) {
            [values addObject:[NSString stringWithUTF8String:argv[i + 1]]];
        }
    }
    return values;
}

static void apply_fields(CNMutableContact *contact, int argc, char **argv) {
    NSString *first = noff_find_arg(argc, argv, "--first");
    NSString *last = noff_find_arg(argc, argv, "--last");
    NSString *org = noff_find_arg(argc, argv, "--org");
    if (first) contact.givenName = first;
    if (last) contact.familyName = last;
    if (org) contact.organizationName = org;

    NSArray<NSString *> *phones = collect_repeated(argc, argv, "--phone");
    if (phones.count) {
        NSMutableArray *values = [NSMutableArray array];
        for (NSString *number in phones) {
            [values addObject:[CNLabeledValue labeledValueWithLabel:CNLabelPhoneNumberMobile
                                                              value:[CNPhoneNumber phoneNumberWithStringValue:number]]];
        }
        contact.phoneNumbers = values;
    }
    NSArray<NSString *> *emails = collect_repeated(argc, argv, "--email");
    if (emails.count) {
        NSMutableArray *values = [NSMutableArray array];
        for (NSString *address in emails) {
            [values addObject:[CNLabeledValue labeledValueWithLabel:CNLabelHome value:address]];
        }
        contact.emailAddresses = values;
    }
}

static int cmd_create(int argc, char **argv, int stdout_fd, BOOL compact, BOOL quiet) {
    if (!require_confirm(argc, argv, stdout_fd, @"create", @"Creating a contact", compact, quiet)) {
        return NOFF_EXIT_INVALID_ARGS;
    }
    NSDictionary *authError = ensure_authorized(@"create");
    if (authError) {
        noff_emit_json(stdout_fd, authError, compact, quiet);
        return NOFF_EXIT_AUTH_DENIED;
    }
    CNMutableContact *contact = [[CNMutableContact alloc] init];
    apply_fields(contact, argc, argv);
    if (contact.givenName.length == 0 && contact.familyName.length == 0
        && contact.organizationName.length == 0) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"create", NOFF_ERR_INVALID_ARGS,
                       @"At least one of --first, --last or --org is required"), compact, quiet);
        return NOFF_EXIT_INVALID_ARGS;
    }
    CNSaveRequest *request = [[CNSaveRequest alloc] init];
    [request addContact:contact toContainerWithIdentifier:nil];
    CNContactStore *store = [[CNContactStore alloc] init];
    NSError *error = nil;
    if (![store executeSaveRequest:request error:&error]) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"create", NOFF_ERR_INTERNAL_ERROR,
                       error.localizedDescription ?: @"Failed to save contact"), compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"create",
                   contact_to_dict(contact, NO)), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static int cmd_update(int argc, char **argv, int stdout_fd, BOOL compact, BOOL quiet) {
    if (!require_confirm(argc, argv, stdout_fd, @"update", @"Updating a contact", compact, quiet)) {
        return NOFF_EXIT_INVALID_ARGS;
    }
    NSDictionary *authError = ensure_authorized(@"update");
    if (authError) {
        noff_emit_json(stdout_fd, authError, compact, quiet);
        return NOFF_EXIT_AUTH_DENIED;
    }
    NSString *identifier = noff_find_arg(argc, argv, "--id");
    if (identifier.length == 0) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"update", NOFF_ERR_INVALID_ARGS,
                       @"--id is required"), compact, quiet);
        return NOFF_EXIT_INVALID_ARGS;
    }
    CNContactStore *store = [[CNContactStore alloc] init];
    NSError *error = nil;
    CNContact *existing = [store unifiedContactWithIdentifier:identifier
                                                  keysToFetch:contact_fetch_keys()
                                                        error:&error];
    if (!existing) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"update", NOFF_ERR_NO_DATA,
                       error.localizedDescription ?: @"No such contact"), compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    CNMutableContact *contact = [existing mutableCopy];
    apply_fields(contact, argc, argv);
    CNSaveRequest *request = [[CNSaveRequest alloc] init];
    [request updateContact:contact];
    if (![store executeSaveRequest:request error:&error]) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"update", NOFF_ERR_INTERNAL_ERROR,
                       error.localizedDescription ?: @"Failed to update contact"), compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"update",
                   contact_to_dict(contact, YES)), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static int cmd_delete(int argc, char **argv, int stdout_fd, BOOL compact, BOOL quiet) {
    if (!require_confirm(argc, argv, stdout_fd, @"delete", @"Deleting a contact", compact, quiet)) {
        return NOFF_EXIT_INVALID_ARGS;
    }
    NSDictionary *authError = ensure_authorized(@"delete");
    if (authError) {
        noff_emit_json(stdout_fd, authError, compact, quiet);
        return NOFF_EXIT_AUTH_DENIED;
    }
    NSString *identifier = noff_find_arg(argc, argv, "--id");
    if (identifier.length == 0) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"delete", NOFF_ERR_INVALID_ARGS,
                       @"--id is required"), compact, quiet);
        return NOFF_EXIT_INVALID_ARGS;
    }
    CNContactStore *store = [[CNContactStore alloc] init];
    NSError *error = nil;
    CNContact *existing = [store unifiedContactWithIdentifier:identifier
                                                  keysToFetch:contact_fetch_keys()
                                                        error:&error];
    if (!existing) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"delete", NOFF_ERR_NO_DATA,
                       error.localizedDescription ?: @"No such contact"), compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    NSDictionary *snapshot = contact_to_dict(existing, NO);
    CNSaveRequest *request = [[CNSaveRequest alloc] init];
    [request deleteContact:[existing mutableCopy]];
    if (![store executeSaveRequest:request error:&error]) {
        noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, @"delete", NOFF_ERR_INTERNAL_ERROR,
                       error.localizedDescription ?: @"Failed to delete contact"), compact, quiet);
        return NOFF_EXIT_ERROR;
    }
    // 回执带上被删对象的快照:删除不可逆,转录里必须留下删了谁。
    noff_emit_json(stdout_fd, noff_json_envelope(TOOL_NAME, @"delete",
                   @{@"deleted": snapshot}), compact, quiet);
    return NOFF_EXIT_SUCCESS;
}

static int contacts_handler(int argc, char **argv,
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
        if ([subcmd isEqualToString:@"status"]) return cmd_status(stdout_fd, compact, quiet);
        if ([subcmd isEqualToString:@"list"])   return cmd_list_or_search(argc, argv, stdout_fd, compact, quiet, NO);
        if ([subcmd isEqualToString:@"search"]) return cmd_list_or_search(argc, argv, stdout_fd, compact, quiet, YES);
        if ([subcmd isEqualToString:@"get"])    return cmd_get(argc, argv, stdout_fd, compact, quiet);
        if ([subcmd isEqualToString:@"groups"]) return cmd_groups(stdout_fd, compact, quiet);
        if ([subcmd isEqualToString:@"create"]) return cmd_create(argc, argv, stdout_fd, compact, quiet);
        if ([subcmd isEqualToString:@"update"]) return cmd_update(argc, argv, stdout_fd, compact, quiet);
        if ([subcmd isEqualToString:@"delete"]) return cmd_delete(argc, argv, stdout_fd, compact, quiet);
    }

    noff_emit_help(stderr_fd, HELP_TEXT);
    noff_emit_json(stdout_fd, noff_json_error(TOOL_NAME, subcmd, NOFF_ERR_INVALID_ARGS,
                   [NSString stringWithFormat:@"Unknown command '%@'. Valid: list, search, get, groups, create, update, delete, status.", subcmd]),
                   compact, quiet);
    return NOFF_EXIT_INVALID_ARGS;
}

void contacts_offload_register(void) {
    int err = native_offload_add_handler("apple-contacts", contacts_handler);
    if (err == 0) {
        noff_ensure_guest_stub("/usr/local/bin/apple-contacts");
        NSLog(@"NativeOffloads: apple-contacts handler registered");
    } else {
        NSLog(@"NativeOffloads: failed to register apple-contacts handler (err=%d)", err);
    }
}
