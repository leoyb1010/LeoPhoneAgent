#pragma once
struct task;
struct fd;
#ifdef LEO_LINUX_DEVICE_PROBE
void leo_test_start_pause(struct task *task, int phase);
int leo_test_start_failure(struct task *task);
void leo_test_after_clone_undo(struct task *parent);
void leo_test_io_pause(struct fd *fd, int writing);
void leo_test_stop_mark(unsigned long long generation);
void leo_test_retired_mark(struct task *task);
int leo_linux_lifecycle_probe(void);
int leo_linux_pending_retired_probe(void);
#endif
