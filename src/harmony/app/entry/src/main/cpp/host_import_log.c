/* Host-only logging for the repository's standalone fakefs importer. */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
void ish_printk(const char *message, ...) {
    va_list args;
    va_start(args, message);
    vfprintf(stderr, message, args);
    va_end(args);
}
_Noreturn void die(const char *message, ...) {
    va_list args;
    va_start(args, message);
    vfprintf(stderr, message, args);
    va_end(args);
    abort();
}
