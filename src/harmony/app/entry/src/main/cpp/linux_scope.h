#pragma once
#include <stdint.h>
struct task;
// task_create/task_destroy and cleanup hooks run while pids_lock is held.
uint64_t leo_scope_inherited_generation(const struct task *parent);
int leo_scope_admit_locked(const struct task *parent);
void leo_scope_created_locked(struct task *task);
void leo_scope_destroyed_locked(struct task *task);
int leo_scope_interrupted(void);
void leo_scope_cleanup_retired(struct task *task);
int leo_scope_start_allowed(const struct task *task);
void leo_scope_thread_finished(uint64_t generation, int pid, uint64_t identity);
