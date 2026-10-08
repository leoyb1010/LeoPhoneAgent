#ifndef LeoVerboseTraceShim_h
#define LeoVerboseTraceShim_h

#include <stdbool.h>

/// [T-ios-log-verbose-tier] Mirror the app's log level into the iSH kernel's
/// high-frequency filesystem traces (fakefs_readdir / realfs_getpath).
/// Compiles and links against iSH builds with or without
/// `ish_set_verbose_trace`: on an older kernel it is a no-op.
void leo_set_kernel_verbose_trace(bool enabled);

#endif
