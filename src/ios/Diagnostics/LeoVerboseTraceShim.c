#include "LeoVerboseTraceShim.h"

// Weak default for kernels that predate util/verbosetrace.c. When the linked
// iSH archive provides the real (strong) definition — its object is always
// pulled in, because fs/fake.c references `ish_verbose_trace_enabled` from
// the same file — the linker picks the strong one and this body is dropped.
// No ish header is included here so this file never conflicts with the
// kernel's own prototype.
__attribute__((weak)) void ish_set_verbose_trace(bool enabled) {
    (void)enabled;
}

void leo_set_kernel_verbose_trace(bool enabled) {
    ish_set_verbose_trace(enabled);
}
