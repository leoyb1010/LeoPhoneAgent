"""Auditable Harmony changes for cancellable I/O and exact guest-task teardown."""


def apply(patch):
    patch("kernel/calls.c", '#include "kernel/task.h"',
          '#include "kernel/task.h"\n#include "linux_io.h"')
    patch("fs/real.c", '#include "kernel/calls.h"',
          '#include "kernel/calls.h"\n#include "linux_io.h"\n#include "linux_scope.h"')
    for name, size in [("kernel/calls.c", "size"), ("fs/real.c", "bufsize")]:
        for operation in ["read", "write"]:
            original = (
                "    ssize_t res;\n    do {\n"
                f"        res = {operation}(fd->real_fd, buf, {size});\n"
                "    } while (res < 0 && errno == EINTR);"
            )
            replacement = f"    ssize_t res = leo_guest_{operation}(fd, buf, {size});"
            patch(name, original, replacement)
    patch("kernel/calls.c", "            int32_t signed_result = (int32_t)fast_result;", """            int32_t signed_result = (int32_t)fast_result;
            if ((syscall_num == 63 || syscall_num == 64) && signed_result == -EINTR)
                current->syscall_restartable = true;""")
    # Positional file I/O has no pipe wait, but must not swallow a fatal signal.
    for operation in ["pread", "pwrite"]:
        original = (
            f"        res = {operation}(fd->real_fd, buf, bufsize, off);\n"
            "    } while (res < 0 && errno == EINTR);"
        )
        replacement = (
            f"        res = {operation}(fd->real_fd, buf, bufsize, off);\n"
            "    } while (res < 0 && errno == EINTR && !leo_scope_interrupted());"
        )
        patch("fs/real.c", original, replacement)
    patch("fs/real.c", "    return open_flags_fake_from_real(flags);",
          """    int guest = open_flags_fake_from_real(flags);
    if (leo_guest_is_pipe(fd))
        guest = (guest & ~O_NONBLOCK_) | (fd->flags & O_NONBLOCK_);
    return guest;""")
    patch("fs/real.c", "    int ret = fcntl(fd->real_fd, F_SETFL, open_flags_real_from_fake(flags));",
          """    int real_flags = leo_guest_host_flags(fd, open_flags_real_from_fake(flags));
    int ret = fcntl(fd->real_fd, F_SETFL, real_flags);""")
    patch("fs/real.c", """    if (ret < 0)
        return errno_map();
    return 0;
}

ssize_t realfs_ioctl_size""", """    if (ret < 0)
        return errno_map();
    fd->flags = (fd->flags & ~(O_APPEND_ | O_NONBLOCK_)) |
                (flags & (O_APPEND_ | O_NONBLOCK_));
    return 0;
}

ssize_t realfs_ioctl_size""")

    patch("kernel/task.h", "    bool leo_thread_finished;",
          "    bool leo_thread_finished;\n    bool leo_force_retired;")
    patch("kernel/task.h", "struct tgroup {",
          "struct tgroup {\n    unsigned leo_retired_threads; // protected by pids_lock")
    patch("kernel/task.c", """struct task *pid_get_task_zombie(dword_t id) {
    struct pid *pid = pid_get(id);
    if (pid == NULL)
        return NULL;
    struct task *task = pid->task;
    return task;
}""", """struct task *pid_get_task_zombie(dword_t id) {
    struct pid *pid = pid_get(id);
    struct task *task = pid == NULL ? NULL : pid->task;
    // In-construction scope tasks are private until task_start has published
    // a valid pthread handle. A failed never-started zombie remains waitable.
    if (task && task->leo_execution_generation &&
        !task->leo_thread_started && !task->zombie)
        return NULL;
    return task;
}""")
    patch("kernel/task.c", "    task->leo_thread_finished = false;",
          "    task->leo_thread_finished = false;\n    task->leo_force_retired = false;\n    task->exiting = false;\n    task->zombie = false;")
    patch("kernel/task.c", """    struct task *self = current;
    if (self != NULL && self->mm_release_deferred""", """    struct task *self = current;
    leo_scope_cleanup_retired(self);
    if (self != NULL && self->mm_release_deferred""")
    patch("kernel/task.c", '#include "linux_scope.h"', '#include "linux_scope.h"\n#include "linux_lifecycle_probe.h"')
    patch("kernel/task.c", """    current = vtask;
    update_thread_name();""", """    // task_start publishes its valid handle and started flag while holding
    // pids_lock. No guest code can run before that publication completes.
    lock(&pids_lock);
    current = vtask;
    unlock(&pids_lock);
    update_thread_name();""")
    patch("kernel/task.c", """    if (!leo_scope_start_allowed(task))
        return _EAGAIN;
    task->leo_thread_started = true;
    int err = pthread_create(&task->thread, &task_thread_attr, task_thread, task);
    if (err != 0) {
        task->leo_thread_started = false;
        return err == EAGAIN ? _EAGAIN : _ENOMEM;
    }
    return 0;""", """#ifdef LEO_LINUX_DEVICE_PROBE
    leo_test_start_pause(task, 0);
#endif
    lock(&pids_lock);
    if (!leo_scope_start_allowed(task)) {
        unlock(&pids_lock);
        return _EAGAIN;
    }
    int err;
#ifdef LEO_LINUX_DEVICE_PROBE
    if (leo_test_start_failure(task)) err = EAGAIN;
    else
#endif
        err = pthread_create(&task->thread, &task_thread_attr, task_thread, task);
    if (err == 0) {
#ifdef LEO_LINUX_DEVICE_PROBE
        leo_test_start_pause(task, 1);
#endif
        task->leo_thread_started = true;
    }
    unlock(&pids_lock);
    if (err != 0)
        return err == EAGAIN ? _EAGAIN : _ENOMEM;
    return 0;""")
    patch("kernel/fork.c", "        task_set_mm(task, mm_copy(mm));", """        struct mm *copied_mm = mm_copy(mm);
        if (copied_mm == NULL) return _ENOMEM;
        task_set_mm(task, copied_mm);""")
    patch("kernel/fork.c", '#include "kernel/ptrace.h"', '#include "kernel/ptrace.h"\n#include "linux_lifecycle_probe.h"')
    patch("kernel/fork.c", "    group->doing_group_exit = false;",
          "    group->doing_group_exit = false;\n    group->leo_retired_threads = 0;")
    patch("kernel/fork.c", "    *group = *old_group;",
          "    if (group == NULL) return NULL;\n    *group = *old_group;")
    patch("kernel/fork.c", """        task->group = tgroup_copy(old_group);
        task->group->leader = task;""", """        struct tgroup *copied = tgroup_copy(old_group);
        if (copied == NULL) {
            unlock(&old_group->lock);
            unlock(&pids_lock);
            err = _ENOMEM;
            goto fail_free_sighand;
        }
        task->group = copied;
        task->group->leader = task;""")
    cleanup = """static void unlink_copied_task(struct task *task, dword_t flags) {
    lock(&pids_lock);
    struct tgroup *group = task->group;
    lock(&group->lock);
    // A sibling's safety valve may have retired this clone before it ever
    // acquired a pthread. Rollback owns that registration and queued signals.
    assert(!task->leo_thread_started);
    if (task->leo_force_retired) {
        assert(group->leo_retired_threads > 0);
        group->leo_retired_threads--;
        task->leo_force_retired = false;
        task->mm_release_deferred = false;
    }
    struct sigqueue *signal, *next_signal;
    list_for_each_entry_safe(&task->queue, signal, next_signal, queue) {
        list_remove(&signal->queue);
        free(signal);
    }
    list_remove_safe(&task->group_links);
    if (!(flags & CLONE_THREAD_)) {
        task_leave_session(task);
        list_remove_safe(&group->pgroup);
    }
    unlock(&group->lock);
    unlock(&pids_lock);
    if (!(flags & CLONE_THREAD_)) {
        cond_destroy(&group->child_exit);
        cond_destroy(&group->stopped_cond);
        pthread_mutex_destroy(&group->lock.m);
        free(group);
    }
}
static void undo_copied_task(struct task *task, dword_t flags) {
    unlink_copied_task(task, flags);
    sighand_release(task->sighand);
    fs_info_release(task->fs);
    fdtable_release(task->files);
    mm_release(task->mm);
    task->sighand = NULL;
    task->fs = NULL;
    task->files = NULL;
    task->mm = NULL;
    task->mem = NULL;
}

"""
    patch("kernel/fork.c", "static int copy_task(", cleanup + "static int copy_task(")
    # Only errors after group insertion need to undo that insertion.
    patch("kernel/fork.c", """        if (err < 0)
            goto fail_free_sighand;
#endif""", """        if (err < 0)
            goto fail_unlink_group;
#endif""")
    for text in ["if (user_put_task(task, ctid_addr, task->pid))",
                 "if (user_put(ptid_addr, task->pid))"]:
        patch("kernel/fork.c", text + "\n            goto fail_free_sighand;",
              text + "\n            goto fail_unlink_group;")
    patch("kernel/fork.c", "fail_free_sighand:\n    sighand_release(task->sighand);",
          """fail_unlink_group:
    unlink_copied_task(task, flags);
fail_free_sighand:
    sighand_release(task->sighand);""")
    patch("kernel/fork.c", """            cond_destroy(&vfork.cond);
        }
        lock(&pids_lock);
        task_destroy(task);""", """            cond_destroy(&vfork.cond);
        }
        undo_copied_task(task, flags);
#ifdef LEO_LINUX_DEVICE_PROBE
        leo_test_after_clone_undo(current);
#endif
        lock(&pids_lock);
        task_destroy(task);""")

    # A timed-out worker owns its resources until it actually leaves its host
    # syscall. Keep its group alive and let its cleanup release those resources.
    patch("kernel/exit.c", '#include "kernel/ptrace.h"', '#include "kernel/ptrace.h"\n#include "linux_lifecycle_probe.h"')
    patch("kernel/exit.c", "    if (task->leo_execution_generation && task->leo_thread_started &&",
          """    if (task->group->leo_retired_threads)
        return false;
    if (task->leo_execution_generation && task->leo_thread_started &&""")
    patch("kernel/exit.c", """    lock(&pids_lock);
    current->exiting = true;""", """    lock(&pids_lock);
    if (current->leo_force_retired) {
        unlock(&pids_lock);
        pthread_exit(NULL);
    }
    current->exiting = true;""")
    patch("kernel/exit.c", """                    task->exiting = true;
                    list_remove(&task->group_links);""", """                    task->exiting = true;
                    task->leo_force_retired = true;
                    group->leo_retired_threads++;
#ifdef LEO_LINUX_DEVICE_PROBE
                    leo_test_retired_mark(task);
#endif
                    list_remove(&task->group_links);""")
    # Remove only the foreign-thread resource releases in the safety valve.
    for member, function in [("sighand", "sighand_release"),
                             ("files", "fdtable_release"), ("fs", "fs_info_release")]:
        original = (
            f"                    if (task->{member} != NULL) {{\n"
            f"                        {function}(task->{member});\n"
            f"                        task->{member} = NULL;\n                    }}"
        )
        patch("kernel/exit.c", original,
              f"                    // {member} is released by this worker's own cleanup.")
    # Preserve TLS for scope-owned early exits so deferred resource cleanup runs.
    # There are two identical entry guards, so apply each with its unique comment.
    patch("kernel/exit.c", """    if (current->exiting) {
        current = NULL;
        pthread_exit(NULL);
    }

    // Block SIGSEGV""", """    if (current->exiting) {
        if (!current->leo_execution_generation) current = NULL;
        pthread_exit(NULL);
    }

    // Block SIGSEGV""")
    patch("kernel/exit.c", """    if (current->exiting) {
        current = NULL;
        pthread_exit(NULL);
    }
    struct tgroup *group""", """    if (current->exiting) {
        if (!current->leo_execution_generation) current = NULL;
        pthread_exit(NULL);
    }
    struct tgroup *group""")

    patch("kernel/exit.c", "                    // Release resources so pipes get EOF and memory is freed.",
          "                    // Keep task-owned references until this worker leaves its host syscall.")
    patch("kernel/exit.c", "leaked %d stuck threads, mm_release deferred", "retired %d host threads pending cleanup")

    patch("kernel/signal.c", "        pthread_kill(task->thread, SIGUSR1);",
          "        if (task->thread) pthread_kill(task->thread, SIGUSR1);")
