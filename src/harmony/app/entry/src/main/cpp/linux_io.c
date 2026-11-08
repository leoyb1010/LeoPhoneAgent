#include "linux_io.h"
#include "fs/fd.h"
#include "kernel/fs.h"
#include "linux_lifecycle_probe.h"
#include "linux_scope.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/stat.h>
#include <unistd.h>

int leo_guest_is_pipe(struct fd *fd) {
    struct stat status;
    return fstat(fd->real_fd, &status) == 0 &&
           (S_ISFIFO(status.st_mode) || S_ISSOCK(status.st_mode));
}
int leo_guest_host_flags(struct fd *fd, int flags) {
    return leo_guest_is_pipe(fd) ? flags | O_NONBLOCK : flags;
}
static ssize_t transfer(struct fd *fd, void *buffer, size_t size, int writing) {
#ifdef LEO_LINUX_DEVICE_PROBE
    leo_test_io_pause(fd, writing);
#endif
    int pipe = leo_guest_is_pipe(fd);
    if (pipe) {
        int flags = fcntl(fd->real_fd, F_GETFL);
        if (flags < 0 ||
            (!(flags & O_NONBLOCK) && fcntl(fd->real_fd, F_SETFL, flags | O_NONBLOCK) < 0))
            return -1;
    }
    for (;;) {
        if (leo_scope_interrupted()) {
            errno = EINTR;
            return -1;
        }
        ssize_t count =
            writing ? write(fd->real_fd, buffer, size) : read(fd->real_fd, buffer, size);
        if (count >= 0)
            return count;
        if (errno == EINTR)
            continue;
        if (!pipe || (errno != EAGAIN && errno != EWOULDBLOCK) || (fd->flags & O_NONBLOCK_))
            return -1;
        struct pollfd descriptor = {
            .fd = fd->real_fd,
            .events = writing ? POLLOUT : POLLIN,
        };
        // All pipe operations above are nonblocking. A signal between the
        // cancellation check and poll cannot strand a reader/writer. The
        // bounded wait also handles a consumed/shared-fd wakeup without spinning.
        int result = poll(&descriptor, 1, 50);
        if (result < 0 && errno != EINTR)
            return -1;
    }
}
ssize_t leo_guest_read(struct fd *fd, void *buffer, size_t size) {
    return transfer(fd, buffer, size, 0);
}
ssize_t leo_guest_write(struct fd *fd, const void *buffer, size_t size) {
    return transfer(fd, (void *)buffer, size, 1);
}
