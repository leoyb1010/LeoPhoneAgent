#ifndef NativeOffloadDispatch_h
#define NativeOffloadDispatch_h

// The kernel stores a plain C function pointer. One fixed trampoline per slot
// preserves the registered capability identity even when execve spoofs argv[0].
#define NOFF_DISPATCH_CAPACITY 32

typedef int (*noff_dispatch_handler)(int argc, char **argv,
                                   int stdin_fd, int stdout_fd, int stderr_fd);
// Return zero to allow, or the tool exit code to deny/cancel before execution.
typedef int (*noff_dispatch_authorizer)(const char *registered_name,
                                      int argc, char **argv,
                                      int stdout_fd, int stderr_fd);
typedef int (*noff_dispatch_registrar)(const char *, noff_dispatch_handler);

int noff_dispatch_register(const char *registered_name,
                           noff_dispatch_handler handler,
                           noff_dispatch_authorizer authorizer,
                           noff_dispatch_registrar registrar);

// Native callers use the same guarded entry as guest execve. Unregistered
// names fail closed; no caller-supplied argv element selects a different tool.
int noff_dispatch_execute(const char *registered_name, int argc, char **argv,
                          int stdin_fd, int stdout_fd, int stderr_fd);
#endif
