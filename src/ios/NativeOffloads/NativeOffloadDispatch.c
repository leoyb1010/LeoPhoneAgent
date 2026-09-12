#include "NativeOffloadDispatch.h"
#include <pthread.h>
#include <stddef.h>
#include <string.h>

struct entry {
    char name[128];
    noff_dispatch_handler handler;
    noff_dispatch_authorizer authorizer;
};
static struct entry entries[NOFF_DISPATCH_CAPACITY];
static size_t entry_count;
static pthread_mutex_t registry_lock = PTHREAD_MUTEX_INITIALIZER;

static int invoke(size_t slot, int argc, char **argv, int in, int out, int err) {
    pthread_mutex_lock(&registry_lock);
    struct entry entry = {0};
    if (slot < entry_count) entry = entries[slot];
    pthread_mutex_unlock(&registry_lock);
    if (!entry.handler || !entry.authorizer) return 3;
    // Never hold a registry/kernel lock across an interactive authorization.
    int decision = entry.authorizer(entry.name, argc, argv, out, err);
    return decision == 0 ? entry.handler(argc, argv, in, out, err) : decision;
}

#define SLOTS(X) \
    X(0) X(1) X(2) X(3) X(4) X(5) X(6) X(7) \
    X(8) X(9) X(10) X(11) X(12) X(13) X(14) X(15) \
    X(16) X(17) X(18) X(19) X(20) X(21) X(22) X(23) \
    X(24) X(25) X(26) X(27) X(28) X(29) X(30) X(31)
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
