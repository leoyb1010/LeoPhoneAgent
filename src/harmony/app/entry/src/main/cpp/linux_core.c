#define ISH_INTERNAL
#include "linux_core.h"
#include "asbestos/frame.h"
#include "fs/devices.h"
#include "fs/fake.h"
#include "fs/path.h"
#include "fs/real.h"
#include "fs/tty.h"
#include "generated/linux_packages_manifest.h"
#include "kernel/calls.h"
#include "kernel/init.h"
#include "kernel/mm.h"
#include "kernel/signal.h"
#include "kernel/task.h"
#include "linux_lifecycle_probe.h"
#include "linux_scope.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <ucontext.h>
#include <unistd.h>
#define SLOT_COUNT 16
#define OUTPUT_LIMIT (1024 * 1024)
#define EXECUTION_TASK_LIMIT 64
#define RUNTIME_TASK_LIMIT 256
struct execution {
    pthread_mutex_t lock;
    _Atomic int pid;
    _Atomic uint64_t generation;
    _Atomic unsigned task_count;
    _Atomic int stop_requested;
    int exited, code, truncated;
    size_t size;
    char *output;
    struct tty *tty;
    struct task *failed_task;
    int terminal_reference_released;
    int stdio_mode;
    int input_fd, output_fd, error_fd;
    char *stderr_output;
    size_t stderr_size;
    int stderr_truncated;
};
static struct execution executions[SLOT_COUNT];
static pthread_mutex_t control = PTHREAD_MUTEX_INITIALIZER;
static struct task *init_task;
static struct execution *creating;
static int booted;
static char guest_data_directory[PATH_MAX];
static char private_files_directory[PATH_MAX];
static struct sigaction previous_segv, previous_bus;
extern __thread volatile sig_atomic_t in_jit;
extern __thread volatile addr_t jit_saved_pc;
extern __thread volatile uint64_t jit_last_host_fault, jit_last_x7, jit_last_x10;
extern __thread volatile int jit_crash_count;
extern void jit_crash_trampoline(void);
extern int do_wait(int idtype, pid_t_ id, struct siginfo_ *info, struct rusage_ *rusage,
                   int options);

// This counter belongs to a slot until every tagged pid AND host pthread has
// finished. Neither reparenting nor setsid changes the inherited generation.
static uint64_t next_generation;
static uint64_t next_task_identity;
static __thread uint64_t creating_generation;
static struct execution *scope_for_generation(uint64_t generation) {
    if (!generation)
        return NULL;
    for (int i = 0; i < SLOT_COUNT; i++)
        if (atomic_load(&executions[i].generation) == generation)
            return &executions[i];
    return NULL;
}
uint64_t leo_scope_inherited_generation(const struct task *parent) {
    return parent && parent->leo_execution_generation ? parent->leo_execution_generation
                                                      : creating_generation;
}
int leo_scope_admit_locked(const struct task *parent) {
    if (parent && (parent->exiting || parent->leo_force_retired ||
                   (parent->group && parent->group->doing_group_exit)))
        return _EAGAIN;
    unsigned total = 0;
    for (int i = 0; i < SLOT_COUNT; i++)
        total += atomic_load(&executions[i].task_count);
    if (total >= RUNTIME_TASK_LIMIT)
        return _EAGAIN;
    uint64_t generation = leo_scope_inherited_generation(parent);
    if (!generation)
        return 0;
    struct execution *execution = scope_for_generation(generation);
    if (!execution || atomic_load(&execution->stop_requested) ||
        atomic_load(&execution->task_count) >= EXECUTION_TASK_LIMIT)
        return _EAGAIN;
    return 0;
}
void leo_scope_created_locked(struct task *task) {
    task->leo_task_identity = ++next_task_identity;
    struct execution *execution = scope_for_generation(task->leo_execution_generation);
    if (execution)
        atomic_fetch_add(&execution->task_count, 1);
}
void leo_scope_destroyed_locked(struct task *task) {
    struct execution *execution = scope_for_generation(task->leo_execution_generation);
    if (execution && (!task->leo_thread_started || task->leo_thread_finished))
        atomic_fetch_sub(&execution->task_count, 1);
}
int leo_scope_start_allowed(const struct task *task) {
    if (task->exiting || task->leo_force_retired || (task->group && task->group->doing_group_exit))
        return 0;
    if (!task->leo_execution_generation)
        return 1;
    struct execution *execution = scope_for_generation(task->leo_execution_generation);
    return execution && !atomic_load(&execution->stop_requested);
}
int leo_scope_interrupted(void) {
    if (!current)
        return 0;
    struct execution *execution = scope_for_generation(current->leo_execution_generation);
    if (execution && atomic_load(&execution->stop_requested))
        return 1;
    // File operations can run while an MM lock is held. Avoid reversing the
    // procfs pids->MM lock order. Pipe waits retry at most 50 ms later.
    if (trylock(&pids_lock) != 0)
        return 0;
    int interrupted = current->exiting || current->leo_force_retired ||
                      (execution && atomic_load(&execution->stop_requested)) ||
                      (current->group && current->group->doing_group_exit);
    if (!interrupted && current->sighand) {
        lock(&current->sighand->lock);
        sigset_t_ unblocked =
            current->pending & (~current->blocked | sig_mask(SIGKILL_) | sig_mask(SIGSTOP_));
        interrupted = unblocked != 0;
        unlock(&current->sighand->lock);
    }
    unlock(&pids_lock);
    return interrupted;
}
void leo_scope_cleanup_retired(struct task *task) {
    if (!task)
        return;
    lock(&pids_lock);
    int retired = task->leo_force_retired;
    unlock(&pids_lock);
    if (!retired)
        return;
    // Only the terminating worker releases these references, after leaving
    // its host syscall. The group remains alive until the final hook below.
    if (task->files) {
        fdtable_release(task->files);
        task->files = NULL;
    }
    if (task->fs) {
        fs_info_release(task->fs);
        task->fs = NULL;
    }
    for (int index = 0; index < 2; index++) {
        if (task->futex_pipe[index] >= 0)
            close(task->futex_pipe[index]);
        task->futex_pipe[index] = -1;
    }
}
void leo_scope_thread_finished(uint64_t generation, int pid, uint64_t identity) {
    if (!generation)
        return;
    lock(&pids_lock);
    struct task *task = pid_get_task_zombie(pid);
    if (task && task->leo_execution_generation == generation &&
        task->leo_task_identity == identity) {
        task->leo_thread_finished = true;
        if (task->leo_force_retired) {
            struct tgroup *group = task->group;
            if (task->sighand) {
                sighand_release(task->sighand);
                task->sighand = NULL;
            }
            struct sigqueue *signal, *next_signal;
            list_for_each_entry_safe(&task->queue, signal, next_signal, queue) {
                list_remove(&signal->queue);
                free(signal);
            }
            struct task *child, *next_child;
            list_for_each_entry_safe(&task->children, child, next_child, siblings) {
                child->parent = init_task;
                list_remove(&child->siblings);
                list_add(&init_task->children, &child->siblings);
            }
            assert(group->leo_retired_threads > 0);
            group->leo_retired_threads--;
            task->leo_force_retired = false;
            // A retired leader still supplies the process's zombie record.
            // Nonleaders have no waitpid record and are destroyed here exactly once.
            if (task != group->leader) {
                if (current == task)
                    current = NULL;
                task_destroy(task);
            }
            notify(&init_task->group->child_exit);
            if (group->leader->parent && group->leader->parent->group)
                notify(&group->leader->parent->group->child_exit);
        } else if (task->parent && task->parent->group) {
            notify(&task->parent->group->child_exit);
        }
    } else {
        // A normal nonleader destroys its row before pthread cleanup runs.
        struct execution *execution = scope_for_generation(generation);
        if (execution)
            atomic_fetch_sub(&execution->task_count, 1);
    }
    unlock(&pids_lock);
}
static int execution_fork_guard(void) {
    lock(&pids_lock);
    int result = leo_scope_admit_locked(current);
    unlock(&pids_lock);
    return result;
}

static void fault_handler(int sig, siginfo_t *info, void *context) {
    ucontext_t *uc = context;
    if (in_jit) {
        struct fiber_frame *frame = (struct fiber_frame *)uc->uc_mcontext.regs[1];
        uint64_t address = (uc->uc_mcontext.regs[7] - uc->uc_mcontext.regs[10]) & 0xffffffffffffULL;
        frame->cpu.segfault_addr = address;
        frame->cpu.segfault_was_write = false;
        const unsigned char *record = (const unsigned char *)uc->uc_mcontext.__reserved;
        const unsigned char *end = record + sizeof(uc->uc_mcontext.__reserved);
        while (record + 8 <= end) {
            uint32_t magic, size;
            memcpy(&magic, record, 4);
            memcpy(&size, record + 4, 4);
            if (size < 8 || record + size > end)
                break;
            if (magic == 0x45535201 && size >= 16) {
                uint64_t esr;
                memcpy(&esr, record + 8, 8);
                frame->cpu.segfault_was_write = (esr & (1ULL << 6)) != 0;
                break;
            }
            record += size;
        }
        frame->cpu.pc = jit_saved_pc;
        jit_last_host_fault = (uint64_t)info->si_addr;
        jit_last_x7 = uc->uc_mcontext.regs[7];
        jit_last_x10 = uc->uc_mcontext.regs[10];
        jit_crash_count++;
        uc->uc_mcontext.sp = frame->jit_exit_sp;
        uc->uc_mcontext.pc = (uint64_t)jit_crash_trampoline;
        return;
    }
    const struct sigaction *previous = sig == SIGSEGV ? &previous_segv : &previous_bus;
    if ((previous->sa_flags & SA_SIGINFO) && previous->sa_sigaction)
        previous->sa_sigaction(sig, info, context);
    else if (previous->sa_handler != SIG_DFL && previous->sa_handler != SIG_IGN &&
             previous->sa_handler)
        previous->sa_handler(sig);
    else {
        signal(sig, SIG_DFL);
        raise(sig);
    }
}
static int terminal_init(struct tty *tty) {
    tty->data = creating;
    if (creating)
        creating->tty = tty;
    return 0;
}
static int terminal_write(struct tty *tty, const void *buffer, size_t size, bool blocking) {
    (void)blocking;
    struct execution *execution = tty->data;
    if (!execution)
        return (int)size;
    pthread_mutex_lock(&execution->lock);
    size_t available = OUTPUT_LIMIT - execution->size;
    size_t copy = size < available ? size : available;
    memcpy(execution->output + execution->size, buffer, copy);
    execution->size += copy;
    if (copy < size)
        execution->truncated = 1;
    pthread_mutex_unlock(&execution->lock);
    return (int)size;
}
static void terminal_cleanup(struct tty *tty) {
    struct execution *execution = tty->data;
    if (execution) {
        pthread_mutex_lock(&execution->lock);
        execution->tty = NULL;
        pthread_mutex_unlock(&execution->lock);
    }
    tty->data = NULL;
}
static const struct tty_driver_ops terminal_ops = {
    .init = terminal_init, .write = terminal_write, .cleanup = terminal_cleanup};
static struct tty_driver terminal_driver = {.ops = &terminal_ops};
static void task_exited(struct task *task, int code) {
    for (int i = 0; i < SLOT_COUNT; i++) {
        struct execution *execution = &executions[i];
        pthread_mutex_lock(&execution->lock);
        if (execution->pid == task->group->leader->pid &&
            atomic_load(&execution->generation) == task->leo_execution_generation) {
            execution->exited = 1;
            execution->code = (code & 0xff) ? 128 + (code & 0xff) : (code >> 8);
        }
        pthread_mutex_unlock(&execution->lock);
    }
}
static int read_exact(FILE *file, void *buffer, size_t count) {
    return fread(buffer, 1, count, file) == count ? 0 : -1;
}
static int safe_relative(const char *path) {
    if (!*path || *path == '/' || strlen(path) > 2048)
        return 0;
    const char *begin = path;
    for (const char *p = path;; p++)
        if (*p == '/' || !*p) {
            size_t n = (size_t)(p - begin);
            if (!n || (n == 1 && begin[0] == '.') || (n == 2 && begin[0] == '.' && begin[1] == '.'))
                return 0;
            if (!*p)
                return 1;
            begin = p + 1;
        }
}
static void remove_staging(const char *path) {
    DIR *directory = opendir(path);
    if (!directory)
        return;
    struct dirent *entry;
    while ((entry = readdir(directory))) {
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, ".."))
            continue;
        char child[PATH_MAX];
        snprintf(child, sizeof(child), "%s/%s", path, entry->d_name);
        struct stat st;
        if (lstat(child, &st) < 0)
            continue;
        if (S_ISDIR(st.st_mode))
            remove_staging(child);
        else
            unlink(child);
    }
    closedir(directory);
    rmdir(path);
}
static int install_root(const char *root, const char *pack) {
    char marker[PATH_MAX];
    snprintf(marker, sizeof(marker), "%s/.leo-installed", root);
    if (access(marker, F_OK) == 0)
        return 0;
    struct stat existing;
    if (lstat(root, &existing) == 0)
        return -1;
    char staging[PATH_MAX];
    snprintf(staging, sizeof(staging), "%s.installing", root);
    // Only this runtime's pre-commit staging directory is disposable.
    if (lstat(staging, &existing) == 0) {
        if (!S_ISDIR(existing.st_mode))
            return -1;
        remove_staging(staging);
    }
    if (mkdir(staging, 0700) < 0)
        return -1;
    FILE *source = fopen(pack, "rb");
    if (!source) {
        remove_staging(staging);
        return -1;
    }
    char magic[8];
    int status = -1;
    if (read_exact(source, magic, 8) < 0 || memcmp(magic, "LEOISH01", 8))
        goto done;
    uint64_t total = 0;
    for (unsigned entry = 0; entry < 20000; entry++) {
        uint32_t length;
        unsigned char directory;
        uint64_t size;
        if (read_exact(source, &length, 4) < 0 || read_exact(source, &directory, 1) < 0 ||
            read_exact(source, &size, 8) < 0)
            goto done;
        if (!length) {
            status = 0;
            break;
        }
        if (length > 2048 || directory > 1 || size > 128 * 1024 * 1024 ||
            total + size > 256 * 1024 * 1024)
            goto done;
        char relative[2049];
        if (read_exact(source, relative, length) < 0)
            goto done;
        relative[length] = 0;
        if (strlen(relative) != length || !safe_relative(relative))
            goto done;
        char path[PATH_MAX];
        if (snprintf(path, sizeof(path), "%s/%s", staging, relative) >= sizeof(path))
            goto done;
        if (directory) {
            if (size || (mkdir(path, 0700) < 0 && errno != EEXIST))
                goto done;
            continue;
        }
        int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
        if (fd < 0)
            goto done;
        char bytes[65536];
        uint64_t left = size;
        while (left) {
            size_t chunk = left < sizeof(bytes) ? left : sizeof(bytes);
            if (read_exact(source, bytes, chunk) < 0 || write(fd, bytes, chunk) != (ssize_t)chunk) {
                close(fd);
                goto done;
            }
            left -= chunk;
        }
        if (fsync(fd) < 0) {
            close(fd);
            goto done;
        }
        close(fd);
        total += size;
    }
    if (status == 0) {
        snprintf(marker, sizeof(marker), "%s/.leo-installed", staging);
        int fd = open(marker, O_WRONLY | O_CREAT | O_EXCL, 0600);
        if (fd < 0 || write(fd, "alpine-3.22.2-arm64", 19) != 19 || fsync(fd) < 0) {
            if (fd >= 0)
                close(fd);
            status = -1;
            goto done;
        }
        close(fd);
        if (rename(staging, root) < 0)
            status = -1;
    }
done:
    fclose(source);
    if (status < 0)
        remove_staging(staging);
    return status;
}
static int install_root_locked(const char *root, const char *pack) {
    char lock_path[PATH_MAX];
    if (snprintf(lock_path, sizeof(lock_path), "%s.install.lock", root) >= sizeof(lock_path))
        return -1;
    int fd = open(lock_path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0)
        return -1;
    if (flock(fd, LOCK_EX) < 0) {
        close(fd);
        return -1;
    }
    int result = install_root(root, pack);
    flock(fd, LOCK_UN);
    close(fd);
    return result;
}

static int prepare_bind_placeholder(const char *path) {
    struct stat status;
    if (lstat(path, &status) == 0) {
        // Upgrade legacy runtime aliases without following their host targets.
        if (S_ISLNK(status.st_mode)) {
            if (unlink(path) < 0)
                return -1;
        } else if (!S_ISDIR(status.st_mode)) {
            return -1;
        }
    } else if (errno != ENOENT) {
        return -1;
    }
    if (mkdir(path, 0700) < 0 && errno != EEXIST)
        return -1;
    int descriptor = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (descriptor < 0)
        return -1;
    DIR *directory = fdopendir(descriptor);
    if (!directory) {
        close(descriptor);
        return -1;
    }
    struct dirent *entry;
    int empty = 1;
    errno = 0;
    while ((entry = readdir(directory))) {
        if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) {
            empty = 0;
            break;
        }
    }
    if (!entry && errno) empty = 0;
    closedir(directory);
    return empty ? 0 : -1;
}

int leo_linux_initialize(const char *root, const char *pack, const char *workspace, char *error,
                         size_t capacity) {
    if (strlen(root) >= PATH_MAX - 256 || strlen(pack) >= PATH_MAX ||
        strlen(workspace) >= PATH_MAX || root[0] != '/' || pack[0] != '/' || workspace[0] != '/') {
        snprintf(error, capacity, "Linux installation paths are invalid");
        return -1;
    }
    pthread_mutex_lock(&control);
    if (booted != 0) {
        if (booted < 0)
            snprintf(error, capacity, "Linux initialization needs an App restart");
        int state = booted > 0 ? 0 : -1;
        pthread_mutex_unlock(&control);
        return state;
    }
    int result = install_root_locked(root, pack);
    if (result < 0) {
        snprintf(error, capacity, "Linux rootfs installation failed; existing data was preserved");
        goto fail;
    }
    char data[PATH_MAX];
    snprintf(data, sizeof(data), "%s/data", root);
    booted = -1;
    snprintf(guest_data_directory, sizeof(guest_data_directory), "%s", data);
    snprintf(private_files_directory, sizeof(private_files_directory), "%s", root);
    char *separator = strrchr(private_files_directory, '/');
    if (!separator || separator == private_files_directory) {
        snprintf(error, capacity, "Linux private directory is invalid");
        result = -1;
        goto fail;
    }
    *separator = 0;
    result = mount_root(&fakefs, data);
    if (result < 0) {
        snprintf(error, capacity, "fakefs mount failed: %d", result);
        goto fail;
    }
    result = become_first_process();
    if (result < 0) {
        snprintf(error, capacity, "init task failed: %d", result);
        goto fail;
    }
    init_task = current;
    // The logical init task never executes guest code on this host thread.
    init_task->thread = 0;
    for (int i = 0; i < SLOT_COUNT; i++)
        pthread_mutex_init(&executions[i].lock, NULL);
    struct sigaction action = {0};
    action.sa_sigaction = fault_handler;
    action.sa_flags = SA_SIGINFO | SA_RESTART;
    sigemptyset(&action.sa_mask);
    sigaction(SIGSEGV, &action, &previous_segv);
    sigaction(SIGBUS, &action, &previous_bus);
    ish_set_anon_page_limit((512 * 1024 * 1024L) / getpagesize());
    generic_mkdirat(AT_PWD, "/dev/pts", 0755);
    generic_mkdirat(AT_PWD, "/proc", 0755);
    generic_mkdirat(AT_PWD, "/mnt", 0755);
    generic_mkdirat(AT_PWD, "/root", 0700);
    generic_mknodat(AT_PWD, "/dev/null", S_IFCHR | 0666, dev_make(MEM_MAJOR, DEV_NULL_MINOR));
    generic_mknodat(AT_PWD, "/dev/zero", S_IFCHR | 0666, dev_make(MEM_MAJOR, DEV_ZERO_MINOR));
    generic_mknodat(AT_PWD, "/dev/random", S_IFCHR | 0666, dev_make(MEM_MAJOR, DEV_RANDOM_MINOR));
    generic_mknodat(AT_PWD, "/dev/urandom", S_IFCHR | 0666, dev_make(MEM_MAJOR, DEV_URANDOM_MINOR));
    generic_mknodat(AT_PWD, "/dev/tty", S_IFCHR | 0666,
                    dev_make(TTY_ALTERNATE_MAJOR, DEV_TTY_MINOR));
    generic_mknodat(AT_PWD, "/dev/ptmx", S_IFCHR | 0666,
                    dev_make(TTY_ALTERNATE_MAJOR, DEV_PTMX_MINOR));
    do_mount(&procfs, "proc", "/proc", "", 0);
    do_mount(&devptsfs, "devpts", "/dev/pts", "", 0);
    // Refresh only the legacy alias and preserve the empty virtual-bind
    // placeholder. Existing nonempty directories require explicit migration.
    char mount_link[PATH_MAX];
    snprintf(mount_link, sizeof(mount_link), "%s/mnt/workspace", data);
    if (prepare_bind_placeholder(mount_link) < 0) {
        snprintf(error, capacity,
                 "Existing guest workspace path was preserved; manual migration is needed");
        result = -1;
        goto fail;
    }
    result = fakefs_bind_mount("/mnt/workspace", workspace, false);
    if (result < 0) {
        snprintf(error, capacity, "workspace mount failed: %d", result);
        goto fail;
    }
    ish_set_fork_guard(execution_fork_guard);
    exit_hook = task_exited;
    booted = 1;
    pthread_mutex_unlock(&control);
    return 0;
fail:
    pthread_mutex_unlock(&control);
    return result < 0 ? result : -1;
}
int leo_linux_prepare_packages(const char *directory, const char *pack, char *error,
                               size_t capacity) {
    pthread_mutex_lock(&control);
    if (booted != 1) {
        snprintf(error, capacity, "Linux must be initialized before preparing packages");
        pthread_mutex_unlock(&control);
        return -1;
    }
    char expected[PATH_MAX];
    snprintf(expected, sizeof(expected), "%s/linux-bootstrap-%.12s", private_files_directory,
             LINUX_PACKAGES_SHA256);
    if (strcmp(directory, expected) || strlen(pack) >= PATH_MAX || pack[0] != '/') {
        snprintf(error, capacity,
                 "Bootstrap package directory does not match the fixed App profile");
        pthread_mutex_unlock(&control);
        return -1;
    }
    int result = install_root_locked(directory, pack);
    if (result < 0) {
        snprintf(error, capacity, "Offline package resource installation did not finish");
        pthread_mutex_unlock(&control);
        return result;
    }
    char link[PATH_MAX];
    snprintf(link, sizeof(link), "%s/mnt/bootstrap", guest_data_directory);
    if (prepare_bind_placeholder(link) < 0) {
        snprintf(error, capacity, "Existing bootstrap mount path was preserved");
        pthread_mutex_unlock(&control);
        return -1;
    }
    current = init_task;
    result = fakefs_bind_mount("/mnt/bootstrap", directory, true);
    if (result < 0)
        snprintf(error, capacity, "Read-only package mount failed: %d", result);
    pthread_mutex_unlock(&control);
    return result;
}

static void close_stdio(struct execution *execution) {
    if (execution->input_fd >= 0)
        close(execution->input_fd);
    if (execution->output_fd >= 0)
        close(execution->output_fd);
    if (execution->error_fd >= 0)
        close(execution->error_fd);
    execution->input_fd = execution->output_fd = execution->error_fd = -1;
}
static int prepare_stdio(struct execution *execution, struct task *task) {
    int input[2] = {-1, -1}, output[2] = {-1, -1}, error[2] = {-1, -1};
    if (pipe(input) < 0 || pipe(output) < 0 || pipe(error) < 0)
        goto fail;
    if (fcntl(input[1], F_SETFL, O_NONBLOCK) < 0 || fcntl(output[0], F_SETFL, O_NONBLOCK) < 0 ||
        fcntl(error[0], F_SETFL, O_NONBLOCK) < 0)
        goto fail;
    int child_fds[3] = {input[0], output[1], error[1]};
    for (int index = 0; index < 3; index++) {
        struct fd *fd = adhoc_fd_create(&realfs_fdops);
        if (!fd)
            goto fail;
        fd->real_fd = child_fds[index];
        fd->flags = index == 0 ? O_RDONLY_ : O_WRONLY_;
        realfs_fstat(fd, &fd->stat);
        task->files->files[index] = fd;
        if (index == 0)
            input[0] = -1;
        else if (index == 1)
            output[1] = -1;
        else
            error[1] = -1;
    }
    execution->input_fd = input[1];
    execution->output_fd = output[0];
    execution->error_fd = error[0];
    return 0;
fail:
    for (int index = 0; index < 2; index++) {
        if (input[index] >= 0)
            close(input[index]);
        if (output[index] >= 0)
            close(output[index]);
        if (error[index] >= 0)
            close(error[index]);
    }
    return -ENOMEM;
}
// Standard output uses backpressure. Diagnostic stderr alone may be truncated
// at its bound.
static void pump_pipe(int *fd, char *buffer, size_t *size, int *truncated, int may_drop) {
    if (*fd < 0)
        return;
    for (int iteration = 0; iteration < 16; iteration++) {
        size_t available = OUTPUT_LIMIT - *size;
        if (!available && !may_drop)
            return;
        char bytes[65536];
        size_t request =
            may_drop ? sizeof(bytes) : (available < sizeof(bytes) ? available : sizeof(bytes));
        ssize_t count = read(*fd, bytes, request);
        if (count < 0 && (errno == EAGAIN || errno == EINTR))
            return;
        if (count <= 0) {
            close(*fd);
            *fd = -1;
            return;
        }
        size_t copy = (size_t)count < available ? (size_t)count : available;
        memcpy(buffer + *size, bytes, copy);
        *size += copy;
        if (copy < (size_t)count)
            *truncated = 1;
    }
}

static void finish_failed_execution(void *data) {
    struct execution *execution = data;
    current = init_task;
    struct siginfo_ info = {0};
    do_wait(1, execution->pid, &info, NULL, 1 | 4);
    pthread_mutex_lock(&control);
    if (execution->tty) {
        lock(&ttys_lock);
        tty_release(execution->tty);
        unlock(&ttys_lock);
    }
    close_stdio(execution);
    free(execution->stderr_output);
    execution->stderr_output = NULL;
    free(execution->output);
    execution->output = NULL;
    execution->failed_task = NULL;
    execution->pid = 0;
    pthread_mutex_unlock(&control);
}
static void *discard_failed_execution(void *data) {
    struct execution *execution = data;
    current = execution->failed_task;
    current->thread = pthread_self();
    pthread_cleanup_push(finish_failed_execution, execution);
    do_exit(127 << 8);
    pthread_cleanup_pop(1);
    return NULL;
}

static int start_process(const char *command, int interactive, int stdio_mode) {
    if (booted != 1)
        return -1;
    if (strlen(command) > 32768)
        return -2;
    pthread_mutex_lock(&control);
    struct execution *execution = NULL;
    for (int i = 0; i < SLOT_COUNT; i++)
        if (!executions[i].pid) {
            execution = &executions[i];
            break;
        }
    if (!execution) {
        pthread_mutex_unlock(&control);
        return -3;
    }
    atomic_store(&execution->generation, ++next_generation);
    atomic_store(&execution->task_count, 0);
    atomic_store(&execution->stop_requested, 0);
    execution->output = malloc(OUTPUT_LIMIT);
    execution->size = 0;
    execution->exited = 0;
    execution->truncated = 0;
    execution->code = 0;
    execution->terminal_reference_released = 0;
    execution->stdio_mode = stdio_mode;
    execution->input_fd = execution->output_fd = execution->error_fd = -1;
    execution->stderr_size = 0;
    execution->stderr_truncated = 0;
    execution->stderr_output = stdio_mode ? malloc(OUTPUT_LIMIT) : NULL;
    if (stdio_mode && !execution->stderr_output) {
        free(execution->output);
        execution->output = NULL;
        pthread_mutex_unlock(&control);
        return -ENOMEM;
    }
    if (!execution->output) {
        free(execution->stderr_output);
        execution->stderr_output = NULL;
        pthread_mutex_unlock(&control);
        return -4;
    }
    struct task *task = NULL;
    current = init_task;
    creating_generation = atomic_load(&execution->generation);
    int result = become_new_init_child();
    creating_generation = 0;
    if (result < 0)
        goto fail;
    task = current;
    // Linux's usual 8 MiB default avoids reserving iSH's 128 MiB ceiling for each
    // libuv worker. The hard limit is retained, so explicit workloads can still
    // raise their own stack limit.
    task->group->limits[RLIMIT_STACK_].cur = 8 * 1024 * 1024;
    execution->pid = task->pid;
    if (stdio_mode) {
        result = prepare_stdio(execution, task);
        if (result < 0)
            goto fail;
    } else {
        creating = execution;
        struct tty *tty = pty_open_fake(&terminal_driver);
        creating = NULL;
        if (IS_ERR(tty)) {
            result = PTR_ERR(tty);
            goto fail;
        }
        struct winsize_ winsize = {.col = 100, .row = 32};
        tty_set_winsize(tty, winsize);
        result = create_stdio("/dev/tty", TTY_PSEUDO_SLAVE_MAJOR, tty->num);
        if (result < 0)
            goto fail;
    }
    const char env[] = "TERM=xterm-256color\0HOME=/root\0PATH=/usr/local/sbin:/"
                       "usr/local/bin:/usr/"
                       "sbin:/usr/bin:/sbin:/bin\0LANG=C.UTF-8\0";
    char *argv = calloc(1, strlen(command) + 32);
    if (!argv) {
        result = _ENOMEM;
        goto fail;
    }
    if (interactive)
        memcpy(argv, "/bin/sh\0-i\0", 11);
    else {
        memcpy(argv, "/bin/sh\0-c\0", 11);
        strcpy(argv + 11, command);
    }
    result = do_execve("/bin/sh", interactive ? 2 : 3, argv, env);
    free(argv);
    if (result < 0)
        goto fail;
    result = task_start(task);
    if (result < 0)
        goto fail;
    int pid = execution->pid;
    current = init_task;
    pthread_mutex_unlock(&control);
    return pid;
fail:
    if (task) {
        execution->failed_task = task;
        pthread_t cleanup_thread;
        if (pthread_create(&cleanup_thread, NULL, discard_failed_execution, execution) == 0) {
            pthread_detach(cleanup_thread);
        } else {
            // Preserve the failed slot and require restart instead of accumulating
            // invisible tasks.
            booted = -1;
        }
    } else {
        close_stdio(execution);
        free(execution->stderr_output);
        execution->stderr_output = NULL;
        free(execution->output);
        execution->output = NULL;
        execution->pid = 0;
    }
    current = init_task;
    pthread_mutex_unlock(&control);
    return result;
}
int leo_linux_start(const char *command, int interactive) {
    return start_process(command, interactive, 0);
}
int leo_linux_start_stdio(const char *command) { return start_process(command, 0, 1); }
static struct execution *find(int pid) {
    for (int i = 0; i < SLOT_COUNT; i++)
        if (executions[i].pid == pid)
            return &executions[i];
    return NULL;
}
int leo_linux_poll_stderr(int pid, char *buffer, size_t capacity, int *truncated) {
    pthread_mutex_lock(&control);
    struct execution *execution = find(pid);
    if (!execution) {
        pthread_mutex_unlock(&control);
        return -1;
    }
    pthread_mutex_lock(&execution->lock);
    if (execution->stdio_mode)
        pump_pipe(&execution->error_fd, execution->stderr_output, &execution->stderr_size,
                  &execution->stderr_truncated, 1);
    size_t count = execution->stderr_size < capacity ? execution->stderr_size : capacity;
    if (count) {
        memcpy(buffer, execution->stderr_output, count);
        memmove(execution->stderr_output, execution->stderr_output + count,
                execution->stderr_size - count);
        execution->stderr_size -= count;
    }
    *truncated = execution->stderr_truncated;
    pthread_mutex_unlock(&execution->lock);
    pthread_mutex_unlock(&control);
    return (int)count;
}
int leo_linux_poll(int pid, char *buffer, size_t capacity, int *exited, int *code, int *truncated) {
    pthread_mutex_lock(&control);
    struct execution *execution = find(pid);
    if (!execution) {
        pthread_mutex_unlock(&control);
        return -1;
    }
    // Logical init also reaps orphaned background children, releasing their TTY
    // references.
    current = init_task;
    for (int count = 0; count < 128; count++) {
        struct siginfo_ info = {0};
        if (do_wait(0, 0, &info, NULL, 1 | 4) < 0 || info.child.pid == 0)
            break;
    }
    pthread_mutex_lock(&execution->lock);
    if (execution->stdio_mode) {
        pump_pipe(&execution->output_fd, execution->output, &execution->size, &execution->truncated,
                  0);
        pump_pipe(&execution->error_fd, execution->stderr_output, &execution->stderr_size,
                  &execution->stderr_truncated, 1);
        if (execution->exited && execution->input_fd >= 0) {
            close(execution->input_fd);
            execution->input_fd = -1;
        }
    }
    size_t copy = execution->size < capacity ? execution->size : capacity;
    memcpy(buffer, execution->output, copy);
    memmove(execution->output, execution->output + copy, execution->size - copy);
    execution->size -= copy;
    int release_reference = execution->exited && !execution->terminal_reference_released;
    struct tty *terminal = execution->tty;
    if (release_reference)
        execution->terminal_reference_released = 1;
    pthread_mutex_unlock(&execution->lock);
    if (release_reference && terminal) {
        lock(&ttys_lock);
        tty_release(terminal);
        unlock(&ttys_lock);
    }
    pthread_mutex_lock(&execution->lock);
    int streams_closed =
        execution->stdio_mode
            ? (execution->output_fd < 0 && execution->error_fd < 0 && execution->stderr_size == 0)
            : execution->tty == NULL;
    *exited = execution->exited && streams_closed && execution->size == 0 &&
              atomic_load(&execution->task_count) == 0;
    *code = execution->code;
    *truncated = execution->truncated;
    int finished = *exited;
    pthread_mutex_unlock(&execution->lock);
    if (finished) {
        close_stdio(execution);
        free(execution->stderr_output);
        execution->stderr_output = NULL;
        free(execution->output);
        execution->output = NULL;
        execution->pid = 0;
    }
    pthread_mutex_unlock(&control);
    return (int)copy;
}
// Hold an explicit terminal reference while the kernel may close a process's
// last fd.
static struct tty *retain_terminal(struct execution *execution) {
    lock(&ttys_lock);
    pthread_mutex_lock(&execution->lock);
    struct tty *terminal = execution->tty;
    if (terminal)
        terminal->refcount++;
    pthread_mutex_unlock(&execution->lock);
    unlock(&ttys_lock);
    return terminal;
}
int leo_linux_write(int pid, const char *buffer, size_t size) {
    if (size > 4096)
        return -1;
    pthread_mutex_lock(&control);
    struct execution *execution = find(pid);
    if (execution && execution->stdio_mode) {
        ssize_t count = execution->input_fd >= 0 ? write(execution->input_fd, buffer, size) : -1;
        int result = count < 0 && errno == EAGAIN ? 0 : (int)count;
        pthread_mutex_unlock(&control);
        return result;
    }
    struct tty *terminal = execution ? retain_terminal(execution) : NULL;
    int result = terminal ? (int)tty_input(terminal, buffer, size, false) : -1;
    if (terminal) {
        lock(&ttys_lock);
        tty_release(terminal);
        unlock(&ttys_lock);
    }
    pthread_mutex_unlock(&control);
    return result;
}
int leo_linux_resize(int pid, int columns, int rows) {
    if (columns < 10 || columns > 500 || rows < 4 || rows > 200)
        return -1;
    pthread_mutex_lock(&control);
    struct execution *execution = find(pid);
    struct tty *terminal = execution ? retain_terminal(execution) : NULL;
    if (terminal) {
        lock(&terminal->lock);
        tty_set_winsize(terminal, (struct winsize_){.col = columns, .row = rows});
        unlock(&terminal->lock);
        lock(&ttys_lock);
        tty_release(terminal);
        unlock(&ttys_lock);
    }
    pthread_mutex_unlock(&control);
    return terminal ? 0 : -1;
}
int leo_linux_stop(int pid) {
    pthread_mutex_lock(&control);
    struct execution *execution = find(pid);
    if (!execution) {
        pthread_mutex_unlock(&control);
        return -1;
    }
    current = init_task;
    uint64_t generation = atomic_load(&execution->generation);
#ifdef LEO_LINUX_DEVICE_PROBE
    leo_test_stop_mark(generation);
#endif
    // Admission, valid-thread publication and cancellation linearize on the
    // same lock. No tagged child can start after this scan without observing
    // stop_requested, and a published child is always included in the scan.
    lock(&pids_lock);
    atomic_store(&execution->stop_requested, 1);
    for (int id = 1; id <= MAX_PID; id++) {
        struct task *task = pid_get_task_zombie(id);
        if (task && !task->zombie && task->leo_thread_started &&
            task->leo_execution_generation == generation)
            send_signal(task, SIGKILL_, SIGINFO_NIL);
    }
    unlock(&pids_lock);
    // The signal is queued before EOF can wake a stdin reader. Internal guest
    // pipes use the same bounded, nonblocking I/O wait path independently.
    if (execution->input_fd >= 0) {
        close(execution->input_fd);
        execution->input_fd = -1;
    }
    int result = 0;
    pthread_mutex_unlock(&control);
    return result;
}

void leo_linux_scope_counts(unsigned *slots, unsigned *tasks) {
    pthread_mutex_lock(&control);
    *slots = *tasks = 0;
    for (int i = 0; i < SLOT_COUNT; i++) {
        if (executions[i].pid)
            (*slots)++;
        *tasks += atomic_load(&executions[i].task_count);
    }
    pthread_mutex_unlock(&control);
}

#ifdef LEO_LINUX_DEVICE_PROBE
// Exercise the production task allocator through a full PID wrap, then deliver
// an older nonleader's delayed cleanup while its numeric PID belongs to a new
// task in the SAME execution. No guest resources are retained by these pending
// (never-started) task copies, so task_destroy is their matching cleanup.
int leo_linux_test_scope_pid_reuse(int pid) {
    pthread_mutex_lock(&control);
    struct execution *execution = find(pid);
    if (!execution) {
        pthread_mutex_unlock(&control);
        return -1;
    }
    lock(&pids_lock);
    struct task *parent = pid_get_task(pid);
    unlock(&pids_lock);
    if (!parent) {
        pthread_mutex_unlock(&control);
        return -2;
    }
    unsigned before = atomic_load(&execution->task_count);
    struct task *old = task_create_(parent);
    if (!old) {
        pthread_mutex_unlock(&control);
        return -3;
    }
    int reused_pid = old->pid;
    uint64_t identity = old->leo_task_identity;
    uint64_t generation = old->leo_execution_generation;
    old->leo_thread_started = true;
    lock(&pids_lock);
    task_destroy(old);
    unlock(&pids_lock);
    struct task *replacement = NULL;
    int allocations = 0;
    for (int iteration = 0; iteration <= MAX_PID; iteration++) {
        struct task *candidate = task_create_(parent);
        if (!candidate)
            break;
        allocations++;
        if (candidate->pid == reused_pid) {
            replacement = candidate;
            break;
        }
        lock(&pids_lock);
        task_destroy(candidate);
        unlock(&pids_lock);
    }
    int result = -4;
    if (replacement) {
        // Publish a waitable never-started zombie so the reused PID lookup is
        // visible without running this pending task's borrowed resources.
        lock(&pids_lock);
        replacement->zombie = true;
        unlock(&pids_lock);
        leo_scope_thread_finished(generation, reused_pid, identity);
        if (!replacement->leo_thread_finished && replacement->leo_task_identity != identity &&
            atomic_load(&execution->task_count) == before + 1)
            result = 0;
        fprintf(stderr,
                "SCOPE_PID_REUSE allocations=%d old_identity=%llu new_identity=%llu result=%d\n",
                allocations, (unsigned long long)identity,
                (unsigned long long)replacement->leo_task_identity, result);
        lock(&pids_lock);
        task_destroy(replacement);
        unlock(&pids_lock);
    }
    if (atomic_load(&execution->task_count) != before)
        result = -5;
    pthread_mutex_unlock(&control);
    return result;
}
#endif
