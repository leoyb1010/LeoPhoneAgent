#pragma once
#include <stddef.h>
#include <sys/types.h>
struct fd;
ssize_t leo_guest_read(struct fd *fd, void *buffer, size_t size);
ssize_t leo_guest_write(struct fd *fd, const void *buffer, size_t size);
int leo_guest_host_flags(struct fd *fd, int flags);
int leo_guest_is_pipe(struct fd *fd);
