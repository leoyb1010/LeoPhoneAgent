#pragma once
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
int leo_linux_initialize(const char *root, const char *pack, const char *workspace, char *error,
                         size_t capacity);
int leo_linux_prepare_packages(const char *directory, const char *pack, char *error,
                               size_t capacity);
int leo_linux_start(const char *command, int interactive);
int leo_linux_start_stdio(const char *command);
int leo_linux_poll_stderr(int pid, char *buffer, size_t capacity, int *truncated);
int leo_linux_poll(int pid, char *buffer, size_t capacity, int *exited, int *code, int *truncated);
int leo_linux_write(int pid, const char *buffer, size_t size);
int leo_linux_resize(int pid, int columns, int rows);
int leo_linux_stop(int pid);
void leo_linux_scope_counts(unsigned *slots, unsigned *tasks);
#ifdef __cplusplus
}
#endif
