#pragma once
#include <sys/stat.h>
#include <unistd.h>
int ohos_bound_parent(int root, const char *path, char *leaf, size_t capacity, int *bound);
int ohos_openat(int root, const char *path, int flags, ...);
int ohos_open(const char *path, int flags, ...);
int ohos_fstatat(int root, const char *path, struct stat *status, int flags);
int ohos_stat(const char *path, struct stat *status);
ssize_t ohos_readlinkat(int root, const char *path, char *buffer, size_t size);
int ohos_unlinkat(int root, const char *path, int flags);
int ohos_unlink(const char *path);
int ohos_rmdir(const char *path);
int ohos_mkdirat(int root, const char *path, mode_t mode);
int ohos_mkdir(const char *path, mode_t mode);
int ohos_move_or_link(int source_root, const char *source, int target_root, const char *target,
                      int link);
int ohos_rename(const char *source, const char *target);
int ohos_link(const char *source, const char *target);
int ohos_renameat(int a, const char *b, int c, const char *d);
int ohos_linkat(int a, const char *b, int c, const char *d, int flags);
int ohos_utimensat(int root, const char *path, const struct timespec times[2], int flags);
int ohos_fchmodat(int root, const char *path, mode_t mode, int flags);
int ohos_fchownat(int root, const char *path, uid_t uid, gid_t gid, int flags);
