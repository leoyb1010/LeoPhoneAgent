// Executes the exact handler pointer handed to the kernel registrar. No Apple
// framework or device data is accessed. Before the dispatch wrapper exists,
// registration follows the original raw-handler path to reproduce the defect.
#include <assert.h>
#include <stdio.h>
#include <string.h>

#if __has_include("../src/ios/NativeOffloads/NativeOffloadDispatch.h")
#include "../src/ios/NativeOffloads/NativeOffloadDispatch.h"
#define HAS_PERMISSION_DISPATCH 1
#else
typedef int (*noff_dispatch_handler)(int, char **, int, int, int);
typedef int (*noff_dispatch_authorizer)(const char *, int, char **, int, int);
#define NOFF_DISPATCH_CAPACITY 32
#endif

static noff_dispatch_handler installed[NOFF_DISPATCH_CAPACITY];
static int installed_count;
static int calls;
static int decision = 3;
static char authorized_command[128];
static int register_backend(const char *name, noff_dispatch_handler handler) {
    if (strcmp(name, "apple-registration-failure") == 0) return -1;
    if (installed_count == NOFF_DISPATCH_CAPACITY) return -1;
    installed[installed_count++] = handler;
    return 0;
}
static int authorize(const char *name, int argc, char **argv, int out, int err) {
    (void)argc; (void)argv; (void)out; (void)err;
    snprintf(authorized_command, sizeof(authorized_command), "%s", name);
    return decision;
}
static int handler(int argc, char **argv, int in, int out, int err) {
    (void)argc; (void)argv; (void)in; (void)out; (void)err;
    calls++;
    return 17;
}
static int register_production(const char *name) {
#ifdef HAS_PERMISSION_DISPATCH
    return noff_dispatch_register(name, handler, authorize, register_backend);
#else
    (void)authorize;
    return register_backend(name, handler);
#endif
}
#define CHECK(condition, message) do { if (!(condition)) { \
    fprintf(stderr, "FAIL: %s\n", message); return 1; } } while (0)
int main(void) {
    CHECK(register_production("apple-contacts") == 0, "register contacts");
    char *args[] = {"apple-device", "list", NULL};
    int result = installed[0](2, args, -1, -1, -1);
    CHECK(result == 3 && calls == 0,
          "denied native invocation must not execute its handler, even with a forged argv[0]");
    CHECK(strcmp(authorized_command, "apple-contacts") == 0, "registration identity must be authoritative");
    decision = 0;
    CHECK(installed[0](2, args, -1, -1, -1) == 17 && calls == 1, "authorized handler result is preserved");
    decision = 130;
    CHECK(installed[0](2, args, -1, -1, -1) == 130 && calls == 1, "cancelled authorization cannot run handler");
#ifdef HAS_PERMISSION_DISPATCH
    decision = 3;
    CHECK(noff_dispatch_execute("apple-contacts", 2, args, -1, -1, -1) == 3 && calls == 1,
          "direct native entry must use the same authorization");
    CHECK(noff_dispatch_execute("apple-unknown", 2, args, -1, -1, -1) == 3,
          "unknown direct entry fails closed");
    CHECK(noff_dispatch_register("apple-no-authorizer", handler, NULL, register_backend) == -1,
          "registration without authorizer fails closed");
    CHECK(register_production("apple-contacts") == 0 && installed_count == 1,
          "identical registration is idempotent");
    CHECK(register_production("apple-registration-failure") == -1, "backend registration failure propagates");
    char names[NOFF_DISPATCH_CAPACITY][48];
    for (int i = 1; i < NOFF_DISPATCH_CAPACITY; i++) {
        snprintf(names[i], sizeof(names[i]), "apple-test-%d", i);
        CHECK(register_production(names[i]) == 0, "bounded registry accepts available slot");
    }
    CHECK(register_production("apple-overflow") == -1 && installed_count == NOFF_DISPATCH_CAPACITY,
          "full registry rejects new capability without registering an unguarded handler");
#endif
    puts("PASS: native dispatch denial, fixed identity, cancellation, direct entry, registration bounds");
    return 0;
}
