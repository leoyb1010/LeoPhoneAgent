/* Device-only integration harness for the same core linked into the App N-API
 * module. */
#include "generated/linux_packages_manifest.h"
#include "linux_core.h"
#include "linux_lifecycle_probe.h"
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
extern int leo_linux_test_scope_pid_reuse(int pid);
static int scope_probe(const char *workspace) {
    const char *owned_names[] = {"air-late-child", "air-late-setsid"};
    for (unsigned i = 0; i < sizeof(owned_names) / sizeof(owned_names[0]); i++) {
        char path[4096];
        snprintf(path, sizeof(path), "%s/%s", workspace, owned_names[i]);
        unlink(path);
    }
    const char *commands[] = {
        "(exec </dev/null >/dev/null 2>&1; sleep 2; echo ESCAPED > /mnt/workspace/air-late-child) "
        "& echo ROOT_CLOSED_CHILD; exit 0",
        "setsid /bin/sh -c 'exec </dev/null >/dev/null 2>&1; sleep 2; echo ESCAPED > "
        "/mnt/workspace/air-late-setsid' & echo ROOT_SETSID_CHILD; exit 0",
        "python3 -c 'import os,time\nfor i in range(100):\n    try:\n        pid=os.fork()\n    "
        "except OSError as error:\n        print(\"PROCESS_QUOTA\",error.errno,flush=True)\n       "
        " break\n    if pid == 0:\n        time.sleep(10)\n        os._exit(0)\ntime.sleep(10)\n'",
        "python3 -c 'import threading,time\nfor i in range(100):\n    try:\n        "
        "threading.Thread(target=time.sleep,args=(10,)).start()\n    except RuntimeError:\n        "
        "print(\"THREAD_QUOTA\",flush=True)\n        break\ntime.sleep(10)\n'",
    };
    for (int round = 0; round < 8; round++) {
        int variant = round % 4;
        int pid = leo_linux_start_stdio(commands[variant]);
        if (pid <= 0)
            return 81;
        unsigned peak = 0;
        int done = 0, code = 0, stopped = 0, saw_root = 0;
        for (int tick = 0; tick < 1500; tick++) {
            char buffer[65537];
            int truncated = 0;
            int size = leo_linux_poll_stderr(pid, buffer, sizeof(buffer) - 1, &truncated);
            if (size < 0)
                return 82;
            if (size > 0)
                fwrite(buffer, 1, size, stderr);
            size = leo_linux_poll(pid, buffer, sizeof(buffer) - 1, &done, &code, &truncated);
            if (size < 0)
                return 83;
            if (size > 0) {
                buffer[size] = 0;
                saw_root |= strstr(buffer, "ROOT_") != NULL;
                fwrite(buffer, 1, size, stdout);
            }
            unsigned slots, tasks;
            leo_linux_scope_counts(&slots, &tasks);
            if (tasks > peak)
                peak = tasks;
            if (tick % 50 == 0 || done)
                fprintf(stderr,
                        "SCOPE_PROGRESS round=%d tick=%d done=%d slots=%u tasks=%u code=%d\n",
                        round, tick, done, slots, tasks, code);
            if (tasks > 64 || slots > 1)
                return 84;
            if (!stopped && ((variant < 2 && tick == 50) || (variant >= 2 && peak == 64))) {
                if (done || (variant < 2 && !saw_root) || tasks == 0)
                    return 85;
                if (variant >= 2 && peak < 64)
                    return 86;
                fprintf(stderr, "SCOPE_BEFORE_CANCEL round=%d slots=%u tasks=%u peak=%u\n", round,
                        slots, tasks, peak);
                if (leo_linux_stop(pid) != 0)
                    return 87;
                stopped = 1;
            }
            if (done) {
                if (!stopped || slots || tasks)
                    return 88;
                fprintf(stderr, "SCOPE_RECLAIMED round=%d exit=%d slots=%u tasks=%u peak=%u\n",
                        round, code, slots, tasks, peak);
                break;
            }
            usleep(10000);
        }
        if (!done)
            return 89;
    }
    int reuse_pid = leo_linux_start_stdio("while :; do :; done");
    if (reuse_pid <= 0 || leo_linux_test_scope_pid_reuse(reuse_pid) != 0)
        return 99;
    leo_linux_stop(reuse_pid);
    int reuse_done = 0;
    for (int tick = 0; tick < 1000 && !reuse_done; tick++) {
        char bytes[4096];
        int code, truncated;
        leo_linux_poll_stderr(reuse_pid, bytes, sizeof(bytes), &truncated);
        leo_linux_poll(reuse_pid, bytes, sizeof(bytes), &reuse_done, &code, &truncated);
        usleep(10000);
    }
    if (!reuse_done)
        return 100;
    int global_pids[4] = {0};
    int global_done[4] = {0};
    unsigned peak_global = 0;
    for (int index = 0; index < 4; index++) {
        global_pids[index] =
            leo_linux_start_stdio("i=0; while [ $i -lt 63 ]; do sleep 30 & i=$((i+1)); done; wait");
        if (global_pids[index] <= 0)
            return 91;
        for (int tick = 0; tick < 500; tick++) {
            unsigned slots, tasks;
            leo_linux_scope_counts(&slots, &tasks);
            if (tasks > peak_global)
                peak_global = tasks;
            if (tasks > 256)
                return 92;
            if (tasks == (unsigned)(index + 1) * 64)
                break;
            if (tick == 499)
                return 93;
            usleep(10000);
        }
    }
    int denied = leo_linux_start_stdio("echo GLOBAL_QUOTA_BYPASSED");
    if (denied >= 0 || peak_global != 256)
        return 94;
    fprintf(stderr, "SCOPE_GLOBAL_QUOTA peak=%u denied=%d\n", peak_global, denied);
    for (int index = 0; index < 4; index++)
        if (leo_linux_stop(global_pids[index]) != 0)
            return 95;
    for (int tick = 0; tick < 1500; tick++) {
        int finished = 0;
        for (int index = 0; index < 4; index++) {
            if (global_done[index]) {
                finished++;
                continue;
            }
            char bytes[65536];
            int truncated = 0, code = 0;
            leo_linux_poll_stderr(global_pids[index], bytes, sizeof(bytes), &truncated);
            if (leo_linux_poll(global_pids[index], bytes, sizeof(bytes), &global_done[index], &code,
                               &truncated) < 0)
                return 96;
            finished += global_done[index];
        }
        if (finished == 4)
            break;
        if (tick == 1499)
            return 97;
        usleep(10000);
    }
    unsigned slots, tasks;
    leo_linux_scope_counts(&slots, &tasks);
    if (slots || tasks)
        return 98;
    fprintf(stderr, "SCOPE_GLOBAL_RECLAIMED slots=%u tasks=%u\n", slots, tasks);
    // The two detached commands would have written these after two seconds.
    sleep(2);
    const char *names[] = {"air-late-child", "air-late-setsid"};
    for (unsigned i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        char path[4096];
        snprintf(path, sizeof(path), "%s/%s", workspace, names[i]);
        if (access(path, F_OK) == 0)
            return 90;
    }
    fprintf(stderr, "SCOPE_ALL_TASKS_RECLAIMED\n");
    return 0;
}

static int io_cancel_probe(void) {
    const char *commands[] = {
        "exec python3 -c 'import os; os.read(0,1)'",
        "exec python3 -c 'import os; os.read(0,8192)'",
        "exec python3 -c 'import os; r,w=os.pipe(); os.read(r,1)'",
        "exec python3 -c 'import os; r,w=os.pipe(); os.read(r,8192)'",
        "exec python3 -c 'import os; r,w=os.pipe(); exec(\"while True: "
        "os.write(w,b\\\"x\\\"*4096)\")'",
        "exec python3 -c 'import os; r,w=os.pipe(); exec(\"while True: "
        "os.write(w,b\\\"x\\\"*8192)\")'",
        "exec python3 -c 'import os; exec(\"while True: os.write(1,b\\\"x\\\"*4096)\")'",
        "exec python3 -c 'import os; exec(\"while True: os.write(1,b\\\"x\\\"*8192)\")'",
        "exec python3 -c 'import os,fcntl; r,w=os.pipe(); os.set_blocking(r,False); assert "
        "fcntl.fcntl(r,fcntl.F_GETFL)&os.O_NONBLOCK; os.set_blocking(r,True); assert not "
        "fcntl.fcntl(r,fcntl.F_GETFL)&os.O_NONBLOCK; os.read(r,8192)'",
        "exec python3 -c 'import os,threading; r,w=os.pipe(); os.write(w,b\"x\"); "
        "a=threading.Thread(target=lambda:os.read(r,1)); "
        "b=threading.Thread(target=lambda:os.read(r,1)); a.start(); b.start(); a.join(); b.join()'",
    };
    for (unsigned round = 0; round < sizeof(commands) / sizeof(commands[0]); round++) {
        int pid = leo_linux_start_stdio(commands[round]);
        if (pid <= 0)
            return 110;
        usleep(500000);
        struct timespec begin, end;
        clock_gettime(CLOCK_MONOTONIC, &begin);
        if (leo_linux_stop(pid) < 0)
            return 111;
        int done = 0, code = 0;
        size_t bytes = 0;
        for (int tick = 0; tick < 1000 && !done; tick++) {
            char output[65536];
            int truncated = 0;
            int count = leo_linux_poll_stderr(pid, output, sizeof(output), &truncated);
            if (count > 0)
                fwrite(output, 1, count, stderr);
            count = leo_linux_poll(pid, output, sizeof(output), &done, &code, &truncated);
            if (count < 0)
                return 112;
            bytes += count;
            if (!done)
                usleep(5000);
        }
        clock_gettime(CLOCK_MONOTONIC, &end);
        unsigned slots, tasks;
        leo_linux_scope_counts(&slots, &tasks);
        long elapsed = (end.tv_sec - begin.tv_sec) * 1000 + (end.tv_nsec - begin.tv_nsec) / 1000000;
        fprintf(stderr,
                "IO_CANCEL round=%u done=%d code=%d slots=%u tasks=%u elapsed_ms=%ld output=%zu\n",
                round, done, code, slots, tasks, elapsed, bytes);
        if (!done || code != 137 || slots || tasks || elapsed > 2000)
            return 113;
    }
    fprintf(stderr, "IO_CANCEL_ALL_RECLAIMED\n");
    return 0;
}

int main(int argc, char **argv) {
    // iSH DPRINTF intentionally writes to its host debug descriptor.
    dup2(STDERR_FILENO, 666);
    if (argc != 5) {
        fprintf(stderr, "Expected rootfs directory, installation pack, workspace "
                        "and guest command\n");
        return 2;
    }
    char error[512] = {0};
    if (leo_linux_initialize(argv[1], argv[2], argv[3], error, sizeof(error)) < 0) {
        fprintf(stderr, "%s\n", error);
        return 3;
    }
    if (strcmp(argv[4], "--pending-retired-probe") == 0)
        return leo_linux_pending_retired_probe();
    if (strcmp(argv[4], "--lifecycle-probe") == 0)
        return leo_linux_lifecycle_probe();
    if (strcmp(argv[4], "--io-cancel-probe") == 0)
        return io_cancel_probe();
    if (strcmp(argv[4], "--scope-probe") == 0)
        return scope_probe(argv[3]);
    if (strcmp(argv[4], "--parallel-probe") == 0) {
        int first = leo_linux_start("while :; do :; done", 0);
        int second = leo_linux_start("sleep 1; echo SECOND_SESSION_SURVIVES", 0);
        if (first <= 0 || second <= 0)
            return 7;
        int done[2] = {0, 0};
        int codes[2] = {0, 0};
        int pids[2] = {first, second};
        for (int tick = 0; tick < 1000; tick++) {
            if (tick == 20)
                leo_linux_stop(first);
            for (int index = 0; index < 2; index++) {
                if (done[index])
                    continue;
                char bytes[65536];
                int truncated = 0;
                int size = leo_linux_poll(pids[index], bytes, sizeof(bytes), &done[index],
                                          &codes[index], &truncated);
                if (size < 0)
                    return 8;
                if (size > 0)
                    fwrite(bytes, 1, size, stdout);
            }
            if (done[0] && done[1]) {
                fprintf(stderr, "PARALLEL_EXIT first=%d second=%d\n", codes[0], codes[1]);
                return codes[0] == 137 && codes[1] == 0 ? 0 : 9;
            }
            usleep(10000);
        }
        return 124;
    }
    const char *command = argv[4];
    if (strcmp(command, "--bootstrap-probe") == 0 ||
        strcmp(command, "--bootstrap-readonly-probe") == 0 ||
        strcmp(command, "--mount-safety-probe") == 0) {
        char parent[4096], directory[4096], pack[4096];
        snprintf(parent, sizeof(parent), "%s", argv[1]);
        char *slash = strrchr(parent, '/');
        if (!slash)
            return 10;
        *slash = 0;
        snprintf(directory, sizeof(directory), "%s/linux-bootstrap-%.12s", parent,
                 LINUX_PACKAGES_SHA256);
        snprintf(pack, sizeof(pack), "%s/linux-packages.pack", parent);
        if (leo_linux_prepare_packages(directory, pack, error, sizeof(error)) < 0) {
            fprintf(stderr, "%s\n", error);
            return 11;
        }
        if (strcmp(command, "--mount-safety-probe") == 0) {
            command = "python3 /mnt/workspace/air-bind-test.py";
        } else if (strcmp(command, "--bootstrap-readonly-probe") == 0) {
            command = "if echo BAD > /mnt/bootstrap/install.sh; then echo "
                      "BOOTSTRAP_WRITE_ESCAPED; "
                      "exit 72; fi; "
                      "echo BOOTSTRAP_READONLY_OK";
        } else {
            command = "/bin/sh /mnt/bootstrap/install.sh";
        }
    }
    int interactive = strcmp(command, "--interactive-probe") == 0;
    int cancel_probe = strcmp(command, "--cancel-probe") == 0;
    int output_probe = strcmp(command, "--output-probe") == 0;
    if (output_probe)
        command = "head -c 2097152 /dev/zero";
    if (cancel_probe)
        command = "while :; do :; done";
    if (strcmp(command, "--boundary-probe") == 0) {
        int directory = open(argv[3], O_RDONLY | O_DIRECTORY);
        unlinkat(directory, "relative-escape", 0);
        unlinkat(directory, "absolute-escape", 0);
        int relative_result = symlinkat("../private-sentinel", directory, "relative-escape");
        char absolute[4096];
        snprintf(absolute, sizeof(absolute), "%s/../private-sentinel", argv[3]);
        int absolute_result = symlinkat(absolute, directory, "absolute-escape");
        close(directory);
        fprintf(stderr, "HOST_LINKS relative=%d absolute=%d\n", relative_result, absolute_result);
        if (relative_result || absolute_result)
            return 6;
        command = "for p in /mnt/workspace/relative-escape "
                  "/mnt/workspace/absolute-escape "
                  "/mnt/workspace/../private-sentinel "
                  "/mnt/workspace/../../private-sentinel "
                  "/data/local/tmp/leobot-linux/private-sentinel /proc/self/fd/4 "
                  "/proc/1/root/data/local/tmp/leobot-linux/private-sentinel; do "
                  "if cat $p 2>/dev/null | grep -q LEO_PRIVATE_SENTINEL; then echo "
                  "READ_ESCAPE_FOUND; exit 42; fi; done; "
                  "echo changed > /mnt/workspace/absolute-escape 2>/dev/null; echo "
                  "GUEST_BOUNDARIES_CHECKED";
    }
    int pid = leo_linux_start(interactive ? "" : command, interactive);
    if (interactive && pid > 0) {
        const char input[] = "echo LEO_PTY_INPUT; exit 7\n";
        int written = leo_linux_write(pid, input, sizeof(input) - 1);
        fprintf(stderr, "PTY_WRITE %d\n", written);
    }
    if (pid <= 0) {
        fprintf(stderr, "GUEST_START_FAILED %d\n", pid);
        return 4;
    }
    if (output_probe)
        sleep(1);
    for (int tick = 0; tick < 12000; tick++) {
        if (cancel_probe && tick == 20)
            fprintf(stderr, "CANCEL_RESULT %d\n", leo_linux_stop(pid));
        char buffer[65536];
        int exited = 0, code = 0, truncated = 0;
        int size = leo_linux_poll(pid, buffer, sizeof(buffer), &exited, &code, &truncated);
        if (size < 0)
            return 5;
        if (size > 0)
            fwrite(buffer, 1, size, stdout);
        fflush(stdout);
        if (exited) {
            fprintf(stderr, "GUEST_EXIT %d truncated=%d\n", code, truncated);
            return code;
        }
        usleep(10000);
    }
    leo_linux_stop(pid);
    fprintf(stderr, "GUEST_TIMEOUT\n");
    return 124;
}
