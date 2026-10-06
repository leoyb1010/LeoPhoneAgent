#include "NativeOffloadDispatch.h"
#include <pthread.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>

struct entry {
    char name[128];
    noff_dispatch_handler handler;
    noff_dispatch_authorizer authorizer;
};
static struct entry entries[NOFF_DISPATCH_CAPACITY];
static size_t entry_count;
static pthread_mutex_t registry_lock = PTHREAD_MUTEX_INITIALIZER;

int noff_arg_has_parent_traversal(const char *arg) {
    // Relative paths too: handlers resolve them against the host cwd.
    if (!arg) return 0;
    const char *p = arg;
    while (*p) {
        while (*p == '/') p++;
        const char *start = p;
        while (*p && *p != '/') p++;
        if (p - start == 2 && start[0] == '.' && start[1] == '.') return 1;
    }
    return 0;
}

static int reject_traversal(const char *name, int argc, char **argv, int out) {
    for (int i = 1; i < argc; i++) {
        if (!noff_arg_has_parent_traversal(argv[i])) continue;
        char msg[320];
        int n = snprintf(msg, sizeof(msg),
            "{\"ok\":false,\"tool\":\"%.100s\",\"error\":{\"code\":\"invalid_args\","
            "\"message\":\"Paths containing '..' are not allowed. Use an absolute path without '..'.\"}}\n",
            name);
        if (out >= 0 && n > 0) (void)!write(out, msg, (size_t)(n < (int)sizeof(msg) ? n : (int)sizeof(msg) - 1));
        return 2;
    }
    return 0;
}

static int invoke(size_t slot, int argc, char **argv, int in, int out, int err) {
    pthread_mutex_lock(&registry_lock);
    struct entry entry = {0};
    if (slot < entry_count) entry = entries[slot];
    pthread_mutex_unlock(&registry_lock);
    if (!entry.handler || !entry.authorizer) return 3;
    // Fail closed before any authorizer or handler sees an escaping path.
    int traversal = reject_traversal(entry.name, argc, argv, out);
    if (traversal != 0) return traversal;
    // Never hold a registry/kernel lock across an interactive authorization.
    int decision = entry.authorizer(entry.name, argc, argv, out, err);
    return decision == 0 ? entry.handler(argc, argv, in, out, err) : decision;
}

#define SLOTS(X) \
    X(0) X(1) X(2) X(3) X(4) X(5) X(6) X(7) \
    X(8) X(9) X(10) X(11) X(12) X(13) X(14) X(15) \
    X(16) X(17) X(18) X(19) X(20) X(21) X(22) X(23) \
    X(24) X(25) X(26) X(27) X(28) X(29) X(30) X(31) \
    X(32) X(33) X(34) X(35) X(36) X(37) X(38) X(39) \
    X(40) X(41) X(42) X(43) X(44) X(45) X(46) X(47)
#define TRAMPOLINE(N) \
    static int dispatch_##N(int argc, char **argv, int in, int out, int err) { \
        return invoke(N, argc, argv, in, out, err); \
    }
SLOTS(TRAMPOLINE)
#define POINTER(N) dispatch_##N,
static noff_dispatch_handler trampolines[] = { SLOTS(POINTER) };
#undef POINTER
#undef TRAMPOLINE
#undef SLOTS
_Static_assert(sizeof(trampolines) / sizeof(trampolines[0]) == NOFF_DISPATCH_CAPACITY,
               "Every registry slot needs a fixed-identity trampoline");

int noff_dispatch_register(const char *name, noff_dispatch_handler handler,
                           noff_dispatch_authorizer authorizer,
                           noff_dispatch_registrar registrar) {
    if (!name || !name[0] || strlen(name) >= sizeof(entries[0].name)
        || !handler || !authorizer || !registrar) return -1;
    pthread_mutex_lock(&registry_lock);
    for (size_t i = 0; i < entry_count; i++) {
        if (strcmp(entries[i].name, name) == 0) {
            int result = entries[i].handler == handler && entries[i].authorizer == authorizer ? 0 : -1;
            pthread_mutex_unlock(&registry_lock);
            return result;
        }
    }
    if (entry_count == NOFF_DISPATCH_CAPACITY) {
        pthread_mutex_unlock(&registry_lock);
        return -1;
    }
    size_t slot = entry_count;
    strcpy(entries[slot].name, name);
    entries[slot].handler = handler;
    entries[slot].authorizer = authorizer;
    // The registrar only stores the pointer; it must not invoke synchronously.
    int result = registrar(name, trampolines[slot]);
    if (result == 0) entry_count++;
    else memset(&entries[slot], 0, sizeof(entries[slot]));
    pthread_mutex_unlock(&registry_lock);
    return result;
}

int noff_dispatch_execute(const char *name, int argc, char **argv,
                          int in, int out, int err) {
    if (!name) return 3;
    pthread_mutex_lock(&registry_lock);
    size_t slot = 0;
    while (slot < entry_count && strcmp(entries[slot].name, name) != 0) slot++;
    int found = slot < entry_count;
    pthread_mutex_unlock(&registry_lock);
    return found ? invoke(slot, argc, argv, in, out, err) : 3;
}
