#!/usr/bin/env python3
"""Prepare the pinned iSH overlay and Alpine fakefs resource without changing deps/ish."""

from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import sqlite3
import struct
import subprocess
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[3]
CPP = ROOT / "src/harmony/app/entry/src/main/cpp"
GENERATED = CPP / "generated"
ISH = ROOT / "deps/ish"
SOURCES = {
    "sqlite.zip": (
        "https://www.sqlite.org/2025/sqlite-amalgamation-3500400.zip",
        "1d3049dd0f830a025a53105fc79fd2ab9431aea99e137809d064d8ee8356b032",
    ),
    "alpine.tar.gz": (
        "https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/aarch64/"
        "alpine-minirootfs-3.22.2-aarch64.tar.gz",
        "6bf491907b705caa5fc65773fbbc1d0954530b6c455d4446f670a4c1fdcea489",
    ),
}
GENERATED.mkdir(parents=True, exist_ok=True)
for name, (url, expected_digest) in SOURCES.items():
    destination = GENERATED / name
    if not destination.exists():
        temporary = destination.with_suffix(".download")
        with urllib.request.urlopen(url, timeout=90) as source, temporary.open("wb") as target:
            shutil.copyfileobj(source, target)
        os.replace(temporary, destination)
    if hashlib.sha256(destination.read_bytes()).hexdigest() != expected_digest:
        raise SystemExit("Pinned SHA256 mismatch: " + name)

sqlite_directory = GENERATED / "sqlite"
sqlite_directory.mkdir(exist_ok=True)
with zipfile.ZipFile(GENERATED / "sqlite.zip") as archive:
    for name in ["sqlite3.c", "sqlite3.h"]:
        expected = archive.read("sqlite-amalgamation-3500400/" + name)
        destination = sqlite_directory / name
        if not destination.exists() or destination.read_bytes() != expected:
            destination.write_bytes(expected)

# Keep every portability change in this reviewable overlay.
for name in ["asbestos", "emu", "kernel", "fs", "util", "platform", "vdso"]:
    shutil.copytree(ISH / name, GENERATED / "ish" / name, dirs_exist_ok=True)
for name in ["debug.h", "misc.h"]:
    shutil.copy2(ISH / name, GENERATED / "ish" / name)
(GENERATED / "ish/tools").mkdir(exist_ok=True)
for header in (ISH / "tools").glob("*.h"):
    shutil.copy2(header, GENERATED / "ish/tools" / header.name)

patches = []
for name in ["kernel/fork.c", "kernel/calls.c", "fs/fake.c"]:
    destination = GENERATED / "ish" / name
    source = destination.read_text()
    source, count = re.subn(
        r"_Atomic\((\w+)\) (\w+) = NULL;",
        r"_Atomic(\1) \2 = (\1)0;",
        source,
    )
    patches.append({"file": name, "atomic_initializers": count})
    if name == "fs/fake.c":
        for original, portable in [
            ("st_mtimespec", "st_mtim"),
            ("st_atimespec", "st_atim"),
            ("st_ctimespec", "st_ctim"),
        ]:
            source = source.replace(original, portable)
        source = source.replace(
            "fcntl(root_fd, F_GETPATH, root_abs)", "ohos_fd_path(root_fd, root_abs)"
        )
        source = source.replace(
            "fcntl(g_fakefs_mount->root_fd, F_GETPATH, fd_path)",
            "ohos_fd_path(g_fakefs_mount->root_fd, fd_path)",
        )
        shim = """
// Resolve only descriptors that this process has already opened.
static int ohos_fd_path(int fd, char *out) {
    char path[64];
    snprintf(path, sizeof(path), "/proc/self/fd/%d", fd);
    ssize_t size = readlink(path, out, PATH_MAX - 1);
    if (size < 0) return -1;
    out[size] = 0;
    return 0;
}
"""
        insertion = source.index("/* ===== Bind Mount Support")
        source = source[:insertion] + shim + source[insertion:]
    destination.write_text(source)

# Constrain physical bind accesses at their shared open/stat/mutation boundaries.
for name in ["fs/fake.c", "fs/real.c"]:
    destination = GENERATED / "ish" / name
    source = destination.read_text()
    calls = [
        "open", "openat", "stat", "fstatat", "readlinkat", "unlink", "unlinkat",
        "rmdir", "mkdir", "mkdirat", "rename", "renameat", "link", "linkat",
        "fchmodat", "fchownat", "utimensat",
    ]
    for call in calls:
        source = re.sub(r"(?<![.>\w])" + call + r"\(", "ohos_" + call + "(", source)
    if name == "fs/fake.c":
        # Mount administration operates on the physical placeholder in rootfs/data.
        # It must never route its cleanup through the guest's newly activated bind alias.
        start_admin = source.index("/* ===== Public Bind Mount API ===== */")
        end_admin = source.index("/* ===== Bind-mount file change notifications", start_admin)
        admin = source[start_admin:end_admin]
        for call in calls:
            admin = admin.replace("ohos_" + call + "(", call + "(")
        source = source[:start_admin] + admin + source[end_admin:]
        declaration = "struct mount *g_fakefs_mount = NULL;"
        insertion = source.index(declaration) + len(declaration)
        source = source[:insertion] + '\n#include "ohos_bind_safety.h"\n' + source[insertion:]
        source = source.replace(
            "fake_stat->size = real_stat.st_size;",
            "if (S_ISLNK(real_stat.st_mode)) ishstat.mode = S_IFLNK | 0777;\n"
            "        fake_stat->size = real_stat.st_size;",
        )
    else:
        source = '#include "ohos_bind_safety_api.h"\n' + source
    destination.write_text(source)
patches.append({
    "file": "fs/fake.c + fs/real.c",
    "host_bind_safety": "fd-relative component walks, O_NOFOLLOW, physical symlink types preserved",
})

# Bind each guest task and host thread to an immutable execution generation.
# The copied cleanup context outlives task_destroy for nonleader pthreads.
def patch_source(name, original, replacement):
    destination = GENERATED / "ish" / name
    text = destination.read_text()
    if text.count(original) != 1:
        raise SystemExit("Unexpected execution-scope overlay anchor: " + name)
    destination.write_text(text.replace(original, replacement, 1))


patch_source(
    "kernel/task.h", "struct task {", """struct task {
    uint64_t leo_execution_generation;
    uint64_t leo_task_identity;
    bool leo_thread_started;
    bool leo_thread_finished;""",
)
patch_source("kernel/task.c", '#include "kernel/task.h"',
             '#include "kernel/task.h"\n#include "linux_scope.h"')
patch_source(
    "kernel/task.c", "    lock(&pids_lock);\n    static int cur_pid = 0;",
    """    lock(&pids_lock);
    if (leo_scope_admit_locked(parent) < 0) {
        unlock(&pids_lock);
        return NULL;
    }
    static int cur_pid = 0;""",
)
patch_source(
    "kernel/task.c", "    task->pid = pid->id;\n    pid->task = task;",
    """    task->pid = pid->id;
    task->thread = 0;
    task->leo_execution_generation = leo_scope_inherited_generation(parent);
    task->leo_thread_started = false;
    task->leo_thread_finished = false;
    leo_scope_created_locked(task);
    pid->task = task;""",
)
patch_source(
    "kernel/task.c", "void task_destroy(struct task *task) {",
    """void task_destroy(struct task *task) {
    leo_scope_destroyed_locked(task);""",
)
patch_source(
    "kernel/task.c", "static void task_run_tlb_cleanup(void *arg) {\n    tlb_free((struct tlb *)arg);",
    """struct leo_run_cleanup {
    struct tlb *tlb;
    uint64_t generation;
    uint64_t identity;
    int pid;
};
static void task_run_tlb_cleanup(void *arg) {
    struct leo_run_cleanup *cleanup = arg;
    tlb_free(cleanup->tlb);""",
)
patch_source(
    "kernel/task.c", '        mm_release_from(mm, "cleanup_handler");\n    }\n}',
    """        mm_release_from(mm, "cleanup_handler");
    }
    leo_scope_thread_finished(cleanup->generation, cleanup->pid, cleanup->identity);
}""",
)
patch_source(
    "kernel/task.c", "    pthread_cleanup_push(task_run_tlb_cleanup, tlb);",
    """    struct leo_run_cleanup cleanup = {
        .tlb = tlb,
        .generation = current->leo_execution_generation,
        .identity = current->leo_task_identity,
        .pid = current->pid,
    };
    pthread_cleanup_push(task_run_tlb_cleanup, &cleanup);""",
)
patch_source(
    "kernel/task.c", "    int err = pthread_create(&task->thread, &task_thread_attr, task_thread, task);\n    if (err != 0)\n        return err == EAGAIN ? _EAGAIN : _ENOMEM;",
    """    if (!leo_scope_start_allowed(task))
        return _EAGAIN;
    task->leo_thread_started = true;
    int err = pthread_create(&task->thread, &task_thread_attr, task_thread, task);
    if (err != 0) {
        task->leo_thread_started = false;
        return err == EAGAIN ? _EAGAIN : _ENOMEM;
    }""",
)
patch_source(
    "kernel/exit.c", "    if (!task->zombie)\n        return false;",
    """    if (!task->zombie)
        return false;
    // A leader's cleanup still reads its task. Do not reap it before the host
    // pthread has passed that final access, even if guest exit was announced.
    if (task->leo_execution_generation && task->leo_thread_started &&
        !task->leo_thread_finished)
        return false;""",
)
patch_source(
    "kernel/fork.c", "    if (!(flags & CLONE_THREAD_)) {\n        ish_fork_guard_t guard =",
    """    {
        ish_fork_guard_t guard =""",
)
patch_source(
    "kernel/fork.c", "        fork_rate_wait(current);   // [T-ish-fork-rate]",
    """        if (!(flags & CLONE_THREAD_))
            fork_rate_wait(current);   // [T-ish-fork-rate]""",
)
# Host-backed filesystem source paths are never a guest mount capability.
# Native mount_root/do_mount initialization bypasses this syscall allowlist.
patch_source(
    "fs/mount.c", "    if (fs == NULL)\n        return _EINVAL;",
    """    if (fs == NULL)
        return _EINVAL;
    if (fs != &procfs && fs != &devptsfs && fs != &tmpfs)
        return _EPERM;""",
)
patch_source(
    "kernel/fork.c",
    "    // task is created. Threads (CLONE_THREAD_) are exempt: they share the\n"
    "    // parent's address space, so they don't add the per-process memory cost\n"
    "    // the guard exists to bound, and denying them would break pthread users.",
    "    // task is created. Harmony bounds both processes and host-backed threads\n"
    "    // and rechecks admission under pids_lock in task_create_.",
)
# Root construction must propagate a bounded-task admission failure.
patch_source(
    "kernel/init.c", "    struct task *task = task_create_(parent);\n",
    """    struct task *task = task_create_(parent);
    if (task == NULL)
        return ERR_PTR(_EAGAIN);
""",
)
patches.append({
    "file": "kernel/task.c + task.h + fork.c + exit.c + init.c",
    "execution_scope": "immutable inherited generation, thread cleanup accounting, fork/clone quotas",
})

# Apply the additional lifecycle fixes after the shared portability overlay.
from linux_lifecycle_overlay import apply as apply_lifecycle_overlay
apply_lifecycle_overlay(patch_source)
patches.append({
    "file": "kernel/task.c + fork.c + exit.c + calls.c + fs/real.c",
    "lifecycle": "atomic start publication, full clone rollback, cancellable pipe I/O, retired-worker cleanup",
})

from linux_bind_overlay import apply as apply_bind_overlay
apply_bind_overlay(GENERATED, patch_source)
patches.append({
    "file": "fs/fake.c",
    "harmony_bind": "virtual bind translation and preserved directory placeholders; App symlinkat is denied",
})

# gen.c's operands match math.S, while bits.S carries older duplicate symbols.
bits = GENERATED / "ish/asbestos/guest-arm64/gadgets-aarch64/bits.S"
source, count = re.subn(
    r"^\.gadget (?:sxtw|uxtb|uxth|rev32)\n.*?^    gret\n",
    "",
    bits.read_text(),
    flags=re.M | re.S,
)
if count != 4:
    raise SystemExit("Unexpected duplicate gadget layout")
bits.write_text(source)
patches.append({
    "file": "asbestos/guest-arm64/gadgets-aarch64/bits.S",
    "removed_duplicate_gadgets": count,
    "owner": "math.S matches gen.c operand format",
})

# The Mac importer uses host libraries only to prepare files, never as App binaries.
rootfs = GENERATED / "rootfs"
compile_importer = [
    "clang", "-std=gnu11", "-D_GNU_SOURCE", "-DGUEST_ARM64=1",
    "-I" + str(ISH), "-I" + str(ISH / "deps/libarchive/libarchive"),
    "-I" + str(sqlite_directory), str(CPP / "host_import_log.c"),
    str(ISH / "tools/fakefsify.c"), str(ISH / "tools/fakefs.c"),
    str(ISH / "util/fchdir.c"), str(ISH / "fs/fake-db.c"),
    str(ISH / "fs/fake-migrate.c"), str(ISH / "fs/fake-rebuild.c"),
    "-larchive", "-lsqlite3", "-o", str(GENERATED / "fakefsify"),
]
import_rootfs = [str(GENERATED / "fakefsify"), str(GENERATED / "alpine.tar.gz"), str(rootfs)]
if not rootfs.exists():
    subprocess.run(compile_importer, check=True)
    subprocess.run(import_rootfs, check=True)
    database = sqlite3.connect(rootfs / "meta.db")
    database.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    database.close()

resource_directory = ROOT / "src/harmony/app/entry/src/main/resources/rawfile"
resource_directory.mkdir(parents=True, exist_ok=True)
resource = resource_directory / "linux-rootfs.pack"
with resource.with_suffix(".tmp").open("wb") as target:
    target.write(b"LEOISH01")
    for entry in sorted(rootfs.rglob("*")):
        relative = entry.relative_to(rootfs).as_posix()
        if entry.is_symlink() or ".." in relative.split("/"):
            raise SystemExit("Unsafe preprocessed path " + relative)
        if entry.name in ["meta.db-wal", "meta.db-shm"]:
            continue
        encoded = relative.encode()
        size = entry.stat().st_size if entry.is_file() else 0
        target.write(struct.pack("<IBQ", len(encoded), 1 if entry.is_dir() else 0, size))
        target.write(encoded)
        if entry.is_file():
            with entry.open("rb") as source:
                shutil.copyfileobj(source, target)
    target.write(struct.pack("<IBQ", 0, 0, 0))
os.replace(resource.with_suffix(".tmp"), resource)

package_metadata = (rootfs / "data/lib/apk/db/installed").read_text()
licenses = [
    "LeoBot HarmonyOS local Linux runtime\n",
    (ISH / "LICENSE.md").read_text(),
    (ISH / "LICENSE.IOS").read_text(),
    (ROOT / "LICENSE").read_text(),
    "SQLite 3.50.4 is in the public domain. https://sqlite.org/copyright.html\n",
    "Alpine 3.22.2 package licenses and source origins follow.\n"
    "Sources are available from https://gitlab.alpinelinux.org/alpine/aports\n",
]
for package in package_metadata.split("\n\n"):
    details = [line for line in package.splitlines() if line[:2] in ["P:", "V:", "L:", "o:", "U:", "c:"]]
    if details:
        licenses.append("\n".join(details) + "\n")
(resource_directory / "linux-licenses.txt").write_text("\n".join(licenses))

manifest = {
    "sources": SOURCES,
    "ish_revision": subprocess.check_output(["git", "-C", str(ISH), "rev-parse", "HEAD"], text=True).strip(),
    "overlay": patches,
    "commands": [compile_importer, import_rootfs],
    "pack_sha256": hashlib.sha256(resource.read_bytes()).hexdigest(),
    "licenses": ["iSH GPLv3 with the repository's additional terms", "SQLite public domain", "Alpine per-package licenses"],
}
(GENERATED / "provenance.json").write_text(json.dumps(manifest, indent=2))
(GENERATED / "linux_manifest.h").write_text(
    '#pragma once\n#define LINUX_PACK_SHA256 "' + manifest["pack_sha256"] + '"\n'
)

# Build only the App runtime. The unused host-CLI tty driver requires pthread_cancel.
build = (ISH / "meson.build").read_text()
start = build.index("    src = [", build.index("if get_option('kernel') == 'ish'"))
end = build.index("    libish = library('ish'", start)
files = re.findall(r"'([^']+\.c)'", build[start:end])
files = [name for name in files if "platform/" not in name and name != "fs/tty-real.c"]
files += [
    "kernel/arch/arm64/calls.c", "fs/fake-db.c", "fs/fake-migrate.c",
    "fs/fake-rebuild.c", "emu/tlb.c", "emu/arch/arm64/fpu.c", "asbestos/asbestos.c",
    "asbestos/helpers.c", "asbestos/guest-arm64/gen.c", "asbestos/guest-arm64/crypto_helpers.c",
    "kernel/native_offload_sym.c", "kernel/native_offload_sym_builtins.c", "kernel/native_offload_prebuilt.c",
]
files += [
    "asbestos/guest-arm64/gadgets-aarch64/" + path.name
    for path in (ISH / "asbestos/guest-arm64/gadgets-aarch64").glob("*.S")
]
(GENERATED / "sources.cmake").write_text(
    "set(ISH_SOURCES\n"
    + "".join(' "${ISH_ROOT}/' + name + '"\n' for name in dict.fromkeys(files))
    + ")\n"
)
print("LINUX_PREPARED", resource.stat().st_size, manifest["pack_sha256"])

subprocess.run([sys.executable, str(Path(__file__).with_name("prepare_linux_packages.py"))], check=True)
