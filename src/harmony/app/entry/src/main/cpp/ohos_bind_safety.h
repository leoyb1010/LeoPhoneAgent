/* Included after iSH's bind table. Every physical bind operation walks pinned
 * directory descriptors without following host symlinks. Guest symlinks retain
 * virtual FS semantics. */
#include <stdarg.h>
// A bind's physical alias must stay at its registered path. Moving any guest
// ancestor would otherwise detach that alias from every prefix-based check.
static int ohos_bind_anchor_or_ancestor(int root, const char *path) {
    char absolute[PATH_MAX];
    const char *guest = NULL;
    if (g_fakefs_mount && root == g_fakefs_mount->root_fd) {
        if (!strcmp(path, ".") || !strcmp(path, "/"))
            guest = "/";
        else {
            int count =
                snprintf(absolute, sizeof(absolute), "%s%s", path[0] == '/' ? "" : "/", path);
            if (count < 0 || (size_t)count >= sizeof(absolute))
                return 1;
            guest = absolute;
        }
    }
    for (int i = 0; i < FAKEFS_MAX_BIND_MOUNTS; i++) {
        const struct fakefs_bind_mount *mount = &g_bind_mounts[i];
        if (!mount->active)
            continue;
        const char *candidate = guest ? guest : path;
        const char *anchor = guest ? mount->path : mount->host_path;
        size_t length = strlen(candidate);
        while (length > 1 && candidate[length - 1] == '/')
            length--;
        if (candidate[0] == '/' && strncmp(anchor, candidate, length) == 0 &&
            (length == 1 || anchor[length] == '/' || !anchor[length]))
            return 1;
    }
    return 0;
}
int ohos_bound_parent(int root, const char *path, char *leaf, size_t capacity, int *bound) {
    const char *relative = NULL;
    const char *host_root = NULL;
    *bound = 0;
    for (int i = 0; i < FAKEFS_MAX_BIND_MOUNTS; i++) {
        const struct fakefs_bind_mount *mount = &g_bind_mounts[i];
        if (!mount->active)
            continue;
        size_t length = strlen(mount->host_path);
        if (strncmp(path, mount->host_path, length) == 0 &&
            (path[length] == '/' || !path[length])) {
            host_root = mount->host_path;
            relative = path + length;
            break;
        }
        const char *guest = path[0] == '/' ? path : NULL;
        char absolute[PATH_MAX];
        if (!guest && g_fakefs_mount && root == g_fakefs_mount->root_fd) {
            snprintf(absolute, sizeof(absolute), "/%s", path);
            guest = absolute;
        }
        if (guest && g_fakefs_mount && root == g_fakefs_mount->root_fd) {
            length = strlen(mount->path);
            if (strncmp(guest, mount->path, length) == 0 &&
                (guest[length] == '/' || !guest[length])) {
                host_root = mount->host_path;
                // 'absolute' is stack storage, preserve the suffix before leaving this
                // block.
                size_t suffix = strlen(guest + length);
                if (suffix >= capacity) {
                    errno = ENAMETOOLONG;
                    return -1;
                }
                memmove(leaf, guest + length, suffix + 1);
                relative = leaf;
                break;
            }
        }
    }
    if (!host_root)
        return -1;
    *bound = 1;
    while (*relative == '/')
        relative++;
    char copy[PATH_MAX];
    if (strlen(relative) >= sizeof(copy)) {
        errno = ENAMETOOLONG;
        return -1;
    }
    strcpy(copy, relative);
    int directory = open(host_root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory < 0)
        return -1;
    if (!*copy) {
        snprintf(leaf, capacity, ".");
        return directory;
    }
    char *component = copy;
    for (;;) {
        char *slash = strchr(component, '/');
        if (slash)
            *slash = 0;
        if (!*component || !strcmp(component, ".") || !strcmp(component, "..")) {
            close(directory);
            errno = EACCES;
            return -1;
        }
        if (!slash) {
            if (strlen(component) >= capacity) {
                close(directory);
                errno = ENAMETOOLONG;
                return -1;
            }
            strcpy(leaf, component);
            return directory;
        }
        int next = openat(directory, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        close(directory);
        if (next < 0)
            return -1;
        directory = next;
        component = slash + 1;
    }
}
int ohos_openat(int root, const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, int);
        va_end(args);
    }
    char leaf[PATH_MAX];
    int bound = 0;
    int parent = ohos_bound_parent(root, path, leaf, sizeof(leaf), &bound);
    if (!bound)
        return openat(root, path, flags, mode);
    if (parent < 0)
        return -1;
    int result = openat(parent, leaf, flags | O_NOFOLLOW | O_CLOEXEC, mode);
    int saved = errno;
    close(parent);
    errno = saved;
    return result;
}
int ohos_open(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, int);
        va_end(args);
    }
    return ohos_openat(AT_FDCWD, path, flags, mode);
}
int ohos_fstatat(int root, const char *path, struct stat *status, int flags) {
    char leaf[PATH_MAX];
    int bound = 0;
    int parent = ohos_bound_parent(root, path, leaf, sizeof(leaf), &bound);
    if (!bound)
        return fstatat(root, path, status, flags);
    if (parent < 0)
        return -1;
    int result = fstatat(parent, leaf, status, AT_SYMLINK_NOFOLLOW);
    int saved = errno;
    close(parent);
    errno = saved;
    return result;
}
int ohos_stat(const char *path, struct stat *status) {
    return ohos_fstatat(AT_FDCWD, path, status, AT_SYMLINK_NOFOLLOW);
}
ssize_t ohos_readlinkat(int root, const char *path, char *buffer, size_t size) {
    char leaf[PATH_MAX];
    int bound = 0;
    int parent = ohos_bound_parent(root, path, leaf, sizeof(leaf), &bound);
    if (!bound)
        return readlinkat(root, path, buffer, size);
    if (parent < 0)
        return -1;
    ssize_t result = readlinkat(parent, leaf, buffer, size);
    int saved = errno;
    close(parent);
    errno = saved;
    return result;
}
int ohos_unlinkat(int root, const char *path, int flags) {
    if (ohos_bind_anchor_or_ancestor(root, path)) {
        errno = EACCES;
        return -1;
    }
    char leaf[PATH_MAX];
    int bound = 0;
    int parent = ohos_bound_parent(root, path, leaf, sizeof(leaf), &bound);
    if (!bound)
        return unlinkat(root, path, flags);
    if (parent < 0)
        return -1;
    if (!strcmp(leaf, ".")) {
        close(parent);
        errno = EACCES;
        return -1;
    }
    int result = unlinkat(parent, leaf, flags);
    int saved = errno;
    close(parent);
    errno = saved;
    return result;
}
int ohos_unlink(const char *path) { return ohos_unlinkat(AT_FDCWD, path, 0); }
int ohos_rmdir(const char *path) { return ohos_unlinkat(AT_FDCWD, path, AT_REMOVEDIR); }
int ohos_mkdirat(int root, const char *path, mode_t mode) {
    char leaf[PATH_MAX];
    int bound = 0;
    int parent = ohos_bound_parent(root, path, leaf, sizeof(leaf), &bound);
    if (!bound)
        return mkdirat(root, path, mode);
    if (parent < 0)
        return -1;
    int result = mkdirat(parent, leaf, mode);
    int saved = errno;
    close(parent);
    errno = saved;
    return result;
}
int ohos_mkdir(const char *path, mode_t mode) { return ohos_mkdirat(AT_FDCWD, path, mode); }
int ohos_move_or_link(int source_root, const char *source, int target_root, const char *target,
                      int link) {
    if (ohos_bind_anchor_or_ancestor(source_root, source) ||
        ohos_bind_anchor_or_ancestor(target_root, target)) {
        errno = EACCES;
        return -1;
    }
    char source_leaf[PATH_MAX], target_leaf[PATH_MAX];
    int source_bound = 0, target_bound = 0;
    int source_parent =
        ohos_bound_parent(source_root, source, source_leaf, sizeof(source_leaf), &source_bound);
    int target_parent =
        ohos_bound_parent(target_root, target, target_leaf, sizeof(target_leaf), &target_bound);
    if ((source_bound && source_parent < 0) || (target_bound && target_parent < 0)) {
        if (source_parent >= 0)
            close(source_parent);
        if (target_parent >= 0)
            close(target_parent);
        return -1;
    }
    if ((source_bound && !strcmp(source_leaf, ".")) ||
        (target_bound && !strcmp(target_leaf, "."))) {
        if (source_parent >= 0)
            close(source_parent);
        if (target_parent >= 0)
            close(target_parent);
        errno = EACCES;
        return -1;
    }
    int result;
    if (link)
        result = linkat(
            source_bound ? source_parent : source_root, source_bound ? source_leaf : source,
            target_bound ? target_parent : target_root, target_bound ? target_leaf : target, 0);
    else
        result = renameat(
            source_bound ? source_parent : source_root, source_bound ? source_leaf : source,
            target_bound ? target_parent : target_root, target_bound ? target_leaf : target);
    int saved = errno;
    if (source_parent >= 0)
        close(source_parent);
    if (target_parent >= 0)
        close(target_parent);
    errno = saved;
    return result;
}
int ohos_rename(const char *source, const char *target) {
    return ohos_move_or_link(AT_FDCWD, source, AT_FDCWD, target, 0);
}
int ohos_link(const char *source, const char *target) {
    return ohos_move_or_link(AT_FDCWD, source, AT_FDCWD, target, 1);
}
int ohos_renameat(int a, const char *b, int c, const char *d) {
    return ohos_move_or_link(a, b, c, d, 0);
}
int ohos_linkat(int a, const char *b, int c, const char *d, int flags) {
    (void)flags;
    return ohos_move_or_link(a, b, c, d, 1);
}

int ohos_utimensat(int root, const char *path, const struct timespec times[2], int flags) {
    char leaf[PATH_MAX];
    int bound = 0;
    int parent = ohos_bound_parent(root, path, leaf, sizeof(leaf), &bound);
    if (!bound)
        return utimensat(root, path, times, flags);
    if (parent < 0)
        return -1;
    int result = utimensat(parent, leaf, times, AT_SYMLINK_NOFOLLOW);
    int saved = errno;
    close(parent);
    errno = saved;
    return result;
}
int ohos_fchmodat(int root, const char *path, mode_t mode, int flags) {
    (void)flags;
    int fd = ohos_openat(root, path, O_RDONLY | O_NOFOLLOW);
    if (fd < 0)
        return -1;
    int result = fchmod(fd, mode);
    int saved = errno;
    close(fd);
    errno = saved;
    return result;
}
int ohos_fchownat(int root, const char *path, uid_t uid, gid_t gid, int flags) {
    (void)flags;
    int fd = ohos_openat(root, path, O_RDONLY | O_NOFOLLOW);
    if (fd < 0)
        return -1;
    int result = fchown(fd, uid, gid);
    int saved = errno;
    close(fd);
    errno = saved;
    return result;
}
