/* Device-only deterministic scheduling/failure fixtures. Never linked in the App. */
#include "linux_lifecycle_probe.h"
#include "fs/fd.h"
#include "kernel/task.h"
#include "linux_core.h"
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

struct resources {
    unsigned mm, files, fs, sighand, threads;
};
static _Atomic unsigned long long armed_generation;
static _Atomic int armed_root, armed_phase, reached, released, stop_seen, retired_seen, undo_seen;
static struct resources baseline;
static int resource_mismatch;
static _Atomic int pending_pid, pending_retired_seen;
static unsigned pending_retired_before, pending_retired_after, pending_signals_before,
    pending_signals_after;
static int pending_rollback_valid;
static struct resources resources(struct task *task) {
    return (struct resources){task->mm->refcount, task->files->refcount, task->fs->refcount,
                              task->sighand->refcount, (unsigned)list_size(&task->group->threads)};
}
static int matches(struct task *task) {
    return task && task->leo_execution_generation == atomic_load(&armed_generation);
}
static void pause_fixture(void) {
    atomic_store(&reached, 1);
    while (!atomic_load(&released))
        usleep(1000);
}
void leo_test_start_pause(struct task *task, int phase) {
    int wanted = atomic_load(&armed_phase);
    if (matches(task) && task->pid != atomic_load(&armed_root) &&
        (wanted == phase || (wanted == 5 && phase == 0))) {
        if (wanted == 5)
            atomic_store(&pending_pid, task->pid);
        if (phase == 1 && (!task->thread || task->leo_thread_started))
            resource_mismatch = 1;
        pause_fixture();
    }
}
int leo_test_start_failure(struct task *task) {
    if (!matches(task) || task->pid == atomic_load(&armed_root) || atomic_load(&armed_phase) != 2)
        return 0;
    atomic_store(&reached, 1);
    return 1;
}
void leo_test_after_clone_undo(struct task *parent) {
    if (!matches(parent))
        return;
    lock(&pids_lock);
    if (atomic_load(&armed_phase) == 5) {
        struct pid *entry = pid_get(atomic_load(&pending_pid));
        struct task *pending = entry ? entry->task : NULL;
        pending_retired_after = parent->group->leo_retired_threads;
        pending_signals_after = pending ? (unsigned)list_size(&pending->queue) : 999;
        pending_rollback_valid = pending && !pending->leo_thread_started &&
                                 !pending->leo_force_retired && !pending->mm_release_deferred &&
                                 !pending->mm && !pending->files && !pending->fs &&
                                 !pending->sighand;
        unlock(&pids_lock);
        atomic_store(&undo_seen, 1);
        return;
    }
    struct resources after = resources(parent);
    unlock(&pids_lock);
    resource_mismatch = memcmp(&baseline, &after, sizeof(after)) != 0;
    fprintf(stderr,
            "CLONE_UNDO_RESOURCES mm=%u/%u files=%u/%u fs=%u/%u sighand=%u/%u threads=%u/%u "
            "mismatch=%d\n",
            baseline.mm, after.mm, baseline.files, after.files, baseline.fs, after.fs,
            baseline.sighand, after.sighand, baseline.threads, after.threads, resource_mismatch);
    atomic_store(&undo_seen, 1);
}
void leo_test_io_pause(struct fd *fd, int writing) {
    if (writing || !matches(current) || !S_ISFIFO(fd->stat.mode))
        return;
    int phase = atomic_load(&armed_phase);
    if ((phase == 3 && current != current->group->leader) ||
        (phase == 4 && current == current->group->leader && fd != current->files->files[0]))
        pause_fixture();
}
void leo_test_stop_mark(unsigned long long generation) {
    if (generation == atomic_load(&armed_generation))
        atomic_store(&stop_seen, 1);
}
void leo_test_retired_mark(struct task *task) {
    if (matches(task)) {
        atomic_store(&retired_seen, 1);
        if (atomic_load(&armed_phase) == 5 && task->pid == atomic_load(&pending_pid)) {
            pending_retired_before = task->group->leo_retired_threads;
            pending_signals_before = (unsigned)list_size(&task->queue);
            atomic_store(&pending_retired_seen, 1);
        }
    }
}
static int arm(int pid, int phase) {
    lock(&pids_lock);
    struct task *task = pid_get_task(pid);
    if (!task) {
        unlock(&pids_lock);
        return -1;
    }
    baseline = resources(task);
    atomic_store(&armed_root, pid);
    atomic_store(&armed_generation, task->leo_execution_generation);
    unlock(&pids_lock);
    atomic_store(&armed_phase, phase);
    atomic_store(&reached, 0);
    atomic_store(&released, 0);
    atomic_store(&stop_seen, 0);
    atomic_store(&retired_seen, 0);
    atomic_store(&undo_seen, 0);
    resource_mismatch = 0;
    return 0;
}
static int wait_flag(_Atomic int *flag) {
    for (int tick = 0; tick < 2000; tick++) {
        if (atomic_load(flag))
            return 0;
        usleep(5000);
    }
    return -1;
}
static int output_until(int pid, const char *marker, int *done, int *code) {
    char collected[8192] = {0};
    size_t used = 0;
    for (int tick = 0; tick < 2000; tick++) {
        char bytes[65536];
        int truncated;
        int size = leo_linux_poll_stderr(pid, bytes, sizeof(bytes), &truncated);
        if (size > 0)
            fwrite(bytes, 1, size, stderr);
        size = leo_linux_poll(pid, bytes, sizeof(bytes), done, code, &truncated);
        if (size < 0)
            return -1;
        if (size > 0) {
            size_t copy = (size_t)size < sizeof(collected) - used - 1
                              ? (size_t)size
                              : sizeof(collected) - used - 1;
            memcpy(collected + used, bytes, copy);
            used += copy;
            collected[used] = 0;
        }
        if (marker && strstr(collected, marker))
            return 0;
        if (*done)
            return marker ? -1 : 0;
        usleep(5000);
    }
    return -1;
}
static void *stop_execution(void *value) {
    leo_linux_stop(*(int *)value);
    return NULL;
}
int leo_linux_lifecycle_probe(void) {
    const char *process = "exec python3 -u -c 'import os,sys; print(\"READY\",flush=True); "
                          "sys.stdin.readline(); p=os.fork(); os._exit(0)'";
    const char *thread = "exec python3 -u -c 'import threading,sys; print(\"READY\",flush=True); "
                         "sys.stdin.readline(); t=threading.Thread(target=lambda:None); t.start(); "
                         "t.join(); print(\"START_SUCCEEDED\",flush=True)'";
    const char *process_failure =
        "exec python3 -u -c 'import os,sys; print(\"READY\",flush=True); sys.stdin.readline(); "
        "exec(\"try:\\n os.fork()\\nexcept OSError:\\n "
        "print(\\\"ROLLBACK_READY\\\",flush=True)\"); sys.stdin.readline()'";
    const char *thread_failure =
        "exec python3 -u -c 'import threading,sys; print(\"READY\",flush=True); "
        "sys.stdin.readline(); exec(\"try:\\n "
        "threading.Thread(target=lambda:None).start()\\nexcept RuntimeError:\\n "
        "print(\\\"ROLLBACK_READY\\\",flush=True)\"); sys.stdin.readline()'";
    for (int phase = 0; phase < 3; phase++) {
        for (int variant = 0; variant < 2; variant++) {
            const char *command = phase == 2 ? (variant ? thread_failure : process_failure)
                                             : (variant ? thread : process);
            int pid = leo_linux_start_stdio(command), done = 0, code = 0;
            if (pid <= 0 || output_until(pid, "READY", &done, &code) < 0 || arm(pid, phase) < 0)
                return 120;
            if (leo_linux_write(pid, "go\n", 3) != 3 || wait_flag(&reached) < 0)
                return 121;
            if (phase == 0) {
                if (leo_linux_stop(pid) != 0)
                    return 122;
                atomic_store(&released, 1);
            } else if (phase == 1) {
                pthread_t stopper;
                if (pthread_create(&stopper, NULL, stop_execution, &pid))
                    return 123;
                if (wait_flag(&stop_seen) < 0)
                    return 124;
                atomic_store(&released, 1);
                pthread_join(stopper, NULL);
            } else {
                if (output_until(pid, "ROLLBACK_READY", &done, &code) < 0 ||
                    !atomic_load(&undo_seen) || resource_mismatch)
                    return 125;
                if (leo_linux_write(pid, "finish\n", 7) != 7)
                    return 126;
            }
            if (output_until(pid, NULL, &done, &code) < 0)
                return 127;
            unsigned slots, tasks;
            leo_linux_scope_counts(&slots, &tasks);
            fprintf(stderr,
                    "START_INTERLEAVE phase=%d variant=%d code=%d slots=%u tasks=%u undo=%d "
                    "mismatch=%d\n",
                    phase, variant, code, slots, tasks, atomic_load(&undo_seen), resource_mismatch);
            if (slots || tasks || (phase < 2 ? code != 137 : code != 0) || resource_mismatch ||
                (phase == 0 && !atomic_load(&undo_seen)))
                return 128;
            atomic_store(&armed_generation, 0);
        }
    }
    const char *retired_worker =
        "exec python3 -u -c 'import os,sys,threading,time; print(\"READY\",flush=True); "
        "sys.stdin.readline(); threading.Thread(target=lambda:os.read(0,8192)).start(); "
        "time.sleep(0.2); os._exit(0)'";
    const char *retired_leader =
        "exec python3 -u -c 'import os,sys,threading,time; print(\"READY\",flush=True); "
        "sys.stdin.readline(); r,w=os.pipe(); "
        "threading.Thread(target=lambda:(time.sleep(0.2),os._exit(0))).start(); os.read(r,8192)'";
    for (int phase = 3; phase <= 4; phase++) {
        int pid = leo_linux_start_stdio(phase == 3 ? retired_worker : retired_leader), done = 0,
            code = 0;
        if (pid <= 0 || output_until(pid, "READY", &done, &code) < 0 || arm(pid, phase) < 0)
            return 130;
        if (leo_linux_write(pid, "go\n", 3) != 3 || wait_flag(&reached) < 0 ||
            wait_flag(&retired_seen) < 0)
            return 131;
        unsigned slots, tasks;
        leo_linux_scope_counts(&slots, &tasks);
        fprintf(stderr, "RETIRED_BEFORE_RELEASE phase=%d slots=%u tasks=%u\n", phase, slots, tasks);
        if (slots != 1 || tasks == 0)
            return 132;
        atomic_store(&released, 1);
        if (output_until(pid, NULL, &done, &code) < 0)
            return 133;
        leo_linux_scope_counts(&slots, &tasks);
        fprintf(stderr, "RETIRED_RECLAIMED phase=%d code=%d slots=%u tasks=%u\n", phase, code,
                slots, tasks);
        if (slots || tasks || code != 0)
            return 134;
        atomic_store(&armed_generation, 0);
    }
    fprintf(stderr, "LIFECYCLE_INTERLEAVES_ALL_RECLAIMED\n");
    return 0;
}

int leo_linux_pending_retired_probe(void) {
    const char *command =
        "exec python3 -u -c 'import threading,sys,os\nready=threading.Event()\nr,w=os.pipe()\ndef "
        "sibling():\n    ready.set()\n    "
        "os.read(r,8192)\nthreading.Thread(target=sibling).start()\nready.wait()\nprint(\"PENDING_"
        "READY\",flush=True)\nsys.stdin.readline()\nthreading.Thread(target=lambda:None).start()"
        "\n'";
    int pid = leo_linux_start_stdio(command), done = 0, code = 0;
    if (pid <= 0 || output_until(pid, "PENDING_READY", &done, &code) < 0 || arm(pid, 5) < 0)
        return 140;
    atomic_store(&pending_pid, 0);
    atomic_store(&pending_retired_seen, 0);
    pending_retired_before = pending_retired_after = pending_signals_before =
        pending_signals_after = 0;
    pending_rollback_valid = 0;
    if (leo_linux_write(pid, "go\n", 3) != 3 || wait_flag(&reached) < 0)
        return 141;
    // B is blocked in an ordinary guest pipe read with Python's GIL released.
    // Deliver only B a fatal guest signal. Its normal signal path calls
    // exit_group while A remains paused starting never-published child C.
    int signalled = 0;
    lock(&pids_lock);
    struct task *root = pid_get_task(pid), *member;
    if (root) {
        list_for_each_entry(&root->group->threads, member, group_links) {
            if (member->pid != pid && member->leo_thread_started) {
                send_signal(member, SIGKILL_, SIGINFO_NIL);
                signalled++;
            }
        }
    }
    unlock(&pids_lock);
    if (signalled != 1 || wait_flag(&pending_retired_seen) < 0)
        return 145;
    // Wait for B's whole retirement critical section before sampling. C can
    // be the first list entry, before A's second registration is recorded.
    lock(&pids_lock);
    root = pid_get_task_zombie(pid);
    pending_retired_before = root ? root->group->leo_retired_threads : 999;
    unlock(&pids_lock);
    fprintf(stderr, "PENDING_RETIRED_BEFORE_UNDO retired=%u queued_signals=%u\n",
            pending_retired_before, pending_signals_before);
    if (pending_retired_before != 2 || !pending_signals_before)
        return 142;
    atomic_store(&released, 1);
    if (output_until(pid, NULL, &done, &code) < 0) {
        unsigned slots, tasks;
        leo_linux_scope_counts(&slots, &tasks);
        fprintf(stderr,
                "PENDING_RETIRED_TIMEOUT retired_after=%u queued_after=%u slots=%u tasks=%u\n",
                pending_retired_after, pending_signals_after, slots, tasks);
        return 143;
    }
    unsigned slots, tasks;
    leo_linux_scope_counts(&slots, &tasks);
    fprintf(stderr, "PENDING_RETIRED_AFTER_UNDO retired=%u queued_signals=%u rollback_valid=%d\n",
            pending_retired_after, pending_signals_after, pending_rollback_valid);
    fprintf(stderr,
            "PENDING_RETIRED_RECLAIMED code=%d slots=%u tasks=%u final_retired_zero_by_reap=%d\n",
            code, slots, tasks, done && !slots && !tasks);
    if (!atomic_load(&undo_seen) || pending_retired_after != 1 || pending_signals_after ||
        !pending_rollback_valid || code != 137 || slots || tasks)
        return 144;
    atomic_store(&armed_generation, 0);
    fprintf(stderr, "PENDING_RETIRED_ROLLBACK_OK\n");
    return 0;
}
