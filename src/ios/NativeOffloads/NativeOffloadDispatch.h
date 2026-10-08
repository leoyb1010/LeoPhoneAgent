#ifndef NativeOffloadDispatch_h
#define NativeOffloadDispatch_h

#include <stdbool.h>

// The kernel stores a plain C function pointer. One fixed trampoline per slot
// preserves the registered capability identity even when execve spoofs argv[0].
#define NOFF_DISPATCH_CAPACITY 48

typedef int (*noff_dispatch_handler)(int argc, char **argv,
                                   int stdin_fd, int stdout_fd, int stderr_fd);
// Return zero to allow, or the tool exit code to deny/cancel before execution.
typedef int (*noff_dispatch_authorizer)(const char *registered_name,
                                      int argc, char **argv,
                                      int stdout_fd, int stderr_fd);
typedef int (*noff_dispatch_registrar)(const char *, noff_dispatch_handler);
// Matches the kernel's native_offload_set_abort_handler. The kernel calls the
// abort function from the SIGNALLING thread with only the signal number, so
// each slot gets its own fixed abort trampoline as well.
typedef bool (*noff_dispatch_abort_fn)(int sig);
typedef int (*noff_dispatch_abort_registrar)(const char *, noff_dispatch_abort_fn);

// `abort_registrar` may be NULL (no guest-signal cancellation for the slot).
int noff_dispatch_register(const char *registered_name,
                           noff_dispatch_handler handler,
                           noff_dispatch_authorizer authorizer,
                           noff_dispatch_registrar registrar,
                           noff_dispatch_abort_registrar abort_registrar);

// Cooperative cancellation for the handler running on the CALLING thread.
// Returns 1 once the slot received a terminating guest signal after this
// invocation started (each invocation starts uncancelled), 0 otherwise or when
// the thread is not inside a dispatched handler. Two concurrent invocations of
// the same tool share the slot, so a kill aimed at one also cancels the other:
// the kernel's abort callback does not identify the task.
int noff_dispatch_cancelled(void);

// Native callers use the same guarded entry as guest execve. Unregistered
// names fail closed; no caller-supplied argv element selects a different tool.
int noff_dispatch_execute(const char *registered_name, int argc, char **argv,
                          int stdin_fd, int stdout_fd, int stderr_fd);

// The kernel turns every argv element that starts with "/" into a host path by
// plain concatenation, without resolving "..", and handlers resolve relative
// paths against the host cwd. Returns 1 when an element has a ".." path
// component (it could escape the rootfs and session folders).
int noff_arg_has_parent_traversal(const char *arg);
#endif
