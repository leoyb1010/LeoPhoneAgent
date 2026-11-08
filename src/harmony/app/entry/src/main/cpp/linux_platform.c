/* OHOS host counters in the byte/tick units required by iSH's platform contract. */
#include "platform/platform.h"
#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/sysinfo.h>

static bool proc_line(const char *file, const char *name, char *buffer, size_t capacity) {
    FILE *source = fopen(file, "r");
    if (!source)
        return false;
    size_t length = strlen(name);
    while (fgets(buffer, (int)capacity, source)) {
        if (!strncmp(name, buffer, length) && buffer[length] == ' ') {
            fclose(source);
            return true;
        }
    }
    fclose(source);
    return false;
}
struct cpu_usage get_cpu_usage(void) {
    struct cpu_usage usage = {0};
    char buffer[1234];
    if (proc_line("/proc/stat", "cpu", buffer, sizeof(buffer))) {
        sscanf(buffer, "cpu %" SCNu64 " %" SCNu64 " %" SCNu64 " %" SCNu64, &usage.user_ticks,
               &usage.nice_ticks, &usage.system_ticks, &usage.idle_ticks);
    }
    return usage;
}
static uint64_t memory_bytes(const char *name) {
    char buffer[1234];
    uint64_t kilobytes = 0;
    if (!proc_line("/proc/meminfo", name, buffer, sizeof(buffer)))
        return 0;
    sscanf(buffer + strlen(name), " %" SCNu64, &kilobytes);
    return kilobytes * 1024;
}
struct mem_usage get_mem_usage(void) {
    struct mem_usage usage = {
        .total = memory_bytes("MemTotal:"),
        .free = memory_bytes("MemFree:"),
        .active = memory_bytes("Active:"),
        .inactive = memory_bytes("Inactive:"),
    };
    if (!usage.total) {
        struct sysinfo information = {0};
        if (sysinfo(&information) == 0) {
            usage.total = (uint64_t)information.totalram * information.mem_unit;
            usage.free = (uint64_t)information.freeram * information.mem_unit;
        }
    }
    return usage;
}
struct uptime_info get_uptime(void) {
    struct sysinfo information = {0};
    sysinfo(&information);
    struct uptime_info usage = {
        .uptime_ticks = (uint64_t)information.uptime * 100,
        .load_1m = information.loads[0],
        .load_5m = information.loads[1],
        .load_15m = information.loads[2],
    };
    return usage;
}
