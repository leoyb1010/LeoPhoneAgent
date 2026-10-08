//
//  FFmpegOffload.m
//  MinisApp
//
//  Native offload handler that routes iSH `ffmpeg` commands to
//  FFmpeg.framework's ffmpeg_main(). Stdin/stdout/stderr are redirected
//  through pipe-backed fds so output streams back to the guest terminal
//  in real time.
//

#import <Foundation/Foundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <errno.h>
#include <time.h>
#include <math.h>
#import "NativeOffloadUtils.h"
#include <FFmpeg/FFmpeg.h>

// ── Thread-local stdio redirection (defined in fftools_stdio_redirect.c,
//    compiled inside FFmpeg.framework) ──
extern _Thread_local int noff_stdout_fd;
extern _Thread_local int noff_stderr_fd;
extern void noff_av_log_redirect_start(void);
extern void noff_av_log_redirect_stop(void);

// ── ffmpeg global state (defined in fftools/*.c) ──
// ffmpeg_cleanup() frees allocated memory but does NOT reset counters
// and flags, causing the second invocation to iterate over freed pointers.
// We must reset every piece of residual state before each call.

// ffmpeg.c
extern int        nb_input_files;
extern int        nb_output_files;
extern void      *input_files;
extern void      *output_files;
extern void      *filtergraphs;
extern int        nb_filtergraphs;

// ffmpeg_opt.c
extern int64_t stats_period;
extern int   stdin_interaction;
extern float audio_drift_threshold;
extern float dts_delta_threshold;
extern float dts_error_threshold;
extern float frame_drop_threshold;
extern int   do_benchmark;
extern int   do_benchmark_all;
extern int   do_hex_dump;
extern int   do_pkt_dump;
extern int   copy_ts;
extern int   start_at_zero;
extern int   copy_tb;
extern int   debug_ts;
extern int   exit_on_error;
extern int   abort_on_flags;
extern int   print_stats;
extern float max_error_rate;
extern int   filter_complex_nbthreads;
extern int   vstats_version;
extern int   auto_conversion_filters;
extern int   do_psnr;
extern int   ignore_unknown_streams;
extern int   copy_unknown_streams;
extern int   recast_media;

// cmdutils.c
extern int   hide_banner;

// Additional state
extern void *vstats_file;
extern void *vstats_filename;
extern void *progress_avio;
extern void *filter_nbthreads;
extern void *filter_hw_device;
extern void *sdp_filename;
extern int   nb_output_dumped;

static void ffmpeg_reset_globals(void) {
    // Reset file-scope/function-local statics in ffmpeg.c
    // (received_sigterm, received_nb_signals, transcode_init_done,
    //  ffmpeg_exited, copy_ts_first_pts, print_report statics, etc.)
    ffmpeg_reset_statics();

    // Counters — critical: if non-zero, next call iterates over freed ptrs
    nb_input_files    = 0;
    nb_output_files   = 0;
    nb_filtergraphs   = 0;
    input_files       = NULL;
    output_files      = NULL;
    filtergraphs      = NULL;
    nb_output_dumped  = 0;

    // Pointers that ffmpeg_cleanup may have freed
    vstats_file       = NULL;
    vstats_filename   = NULL;
    progress_avio     = NULL;
    filter_nbthreads  = NULL;
    filter_hw_device  = NULL;
    sdp_filename      = NULL;

    // Options — reset to defaults (values from ffmpeg_opt.c initializers)
    audio_drift_threshold    = 0.1f;
    dts_delta_threshold      = 10.0f;
    dts_error_threshold      = 3600.0f * 30.0f;
    frame_drop_threshold     = 0.0f;
    do_benchmark             = 0;
    do_benchmark_all         = 0;
    do_hex_dump              = 0;
    do_pkt_dump              = 0;
    copy_ts                  = 0;
    start_at_zero            = 0;
    copy_tb                  = -1;
    debug_ts                 = 0;
    exit_on_error            = 0;
    abort_on_flags           = 0;
    print_stats              = -1;
    max_error_rate           = 2.0f / 3.0f;
    filter_complex_nbthreads = 0;
    vstats_version           = 2;
    auto_conversion_filters  = 1;
    do_psnr                  = 0;
    ignore_unknown_streams   = 0;
    copy_unknown_streams     = 0;
    recast_media             = 0;
    hide_banner              = 0;
    stdin_interaction        = 1;
    stats_period             = 500000;
}

// ── Codec / option rewriting for iOS (VideoToolbox) ──
// Maps software encoders to hardware equivalents and strips
// options that VideoToolbox doesn't understand.

// Options that are libx264/libx265-specific or invalid for in-process
// encoding.  When we rewrite the codec, these must be removed (with their
// argument).  `-pass` is stripped because multi-pass rate control uses
// software-encoder internals (AVExpr / MpegEncContext) whose global state
// corrupts the heap on the second in-process ffmpeg_main() call — and
// VideoToolbox ignores it anyway; the target bitrate (-b:v) is sufficient.
static const char *unsupported_opts[] = {
    "-preset", "-tune", "-profile:v",
    "-q:v", "-qscale:v",
    "-pass", "-passlogfile",
    NULL
};

static bool is_unsupported_opt(const char *arg) {
    for (const char **p = unsupported_opts; *p; p++)
        if (strcmp(arg, *p) == 0) return true;
    return false;
}

// Returns true if `val` looks like a codec value string (not a flag).
static bool is_codec_flag(const char *flag) {
    return flag[0] == '-' && flag[1] != '\0';
}

/// Rewrite argv in-place: swap codecs, convert -crf to -q:v, drop
/// unsupported options. Returns the new argc (may be smaller).
static int rewrite_argv_for_videotoolbox(int argc, char **argv) {
    int dst = 0;
    for (int i = 0; i < argc; i++) {
        // Rewrite codec names: -c:v / -vcodec value
        if ((strcmp(argv[i], "-c:v") == 0 || strcmp(argv[i], "-vcodec") == 0)
            && i + 1 < argc) {
            argv[dst++] = argv[i]; i++;
            if (strcmp(argv[i], "libx264") == 0 || strcmp(argv[i], "libx265") == 0) {
                const char *hw = (strcmp(argv[i], "libx265") == 0)
                    ? "hevc_videotoolbox" : "h264_videotoolbox";
                // argv strings are strdup'd by native_offload, safe to replace
                free(argv[i]);
                argv[i] = strdup(hw);
            }
            argv[dst++] = argv[i];
            continue;
        }

        // Convert -crf N → -b:v Xk  (VideoToolbox uses bitrate, not CRF/qscale)
        // Rough mapping: CRF 18→5M, 23→2M, 28→1M, 33→500k, 51→100k
        if (strcmp(argv[i], "-crf") == 0 && i + 1 < argc) {
            int crf = atoi(argv[i + 1]);
            // Exponential mapping: bitrate ≈ 8000 * 2^((18-crf)/6) kbps
            double br_kbps = 8000.0 * pow(2.0, (18.0 - crf) / 6.0);
            if (br_kbps < 100) br_kbps = 100;
            if (br_kbps > 20000) br_kbps = 20000;
            char buf[32];
            snprintf(buf, sizeof(buf), "%dk", (int)br_kbps);
            free(argv[i]);
            argv[i] = strdup("-b:v");
            free(argv[i + 1]);
            argv[i + 1] = strdup(buf);
            argv[dst++] = argv[i]; i++;
            argv[dst++] = argv[i];
            continue;
        }

        // Drop unsupported options (with their argument)
        if (is_unsupported_opt(argv[i])) {
            free(argv[i]);
            // Skip the argument too if next arg doesn't look like a flag
            if (i + 1 < argc && !is_codec_flag(argv[i + 1])) {
                free(argv[i + 1]);
                i++;
            }
            continue;
        }

        argv[dst++] = argv[i];
    }
    argv[dst] = NULL;
    return dst;
}

// ── Serialize ffmpeg invocations ──
// ffmpeg_main() relies on global state that is NOT thread-safe.
// Concurrent calls corrupt the heap and cause NULL-pointer crashes.
static pthread_mutex_t ffmpeg_mutex = PTHREAD_MUTEX_INITIALIZER;

// [T-ish-offload-signal-forward] Abandoned-transcode state.
//
// A guest kill/Ctrl-C reaches this handler through its dispatch slot's abort
// callback (noff_is_cancelled). We first ask ffmpeg_main() to unwind through
// its own cleanup (ffmpeg_request_cancel); that is the normal path and leaves
// ffmpeg reusable. Only if it does not return within FFMPEG_CANCEL_GRACE_MS
// (wedged inside VideoToolbox) is the worker orphaned. An orphan still owns
// ffmpeg's non-thread-safe globals, so every later invocation must fail fast
// instead of racing it (or blocking on the mutex forever).
static atomic_bool g_ffmpeg_poisoned = ATOMIC_VAR_INIT(false);
#define FFMPEG_CANCEL_GRACE_MS 2000

// ── Run ffmpeg_main on a thread with a full-size stack ──
//
// Heap-allocated and reference-counted, NOT a stack local: if the wait is
// abandoned this frame dies while the orphan still writes `ret` and reads
// `argv`. Whoever finishes last frees.
struct ffmpeg_thread_ctx {
    int argc;
    char **argv;
    int out_fd;
    int err_fd;
    int ret;
    atomic_int refcount;   // 2 while both sides hold it
    bool argv_owned;       // true once the ctx owns an argv copy
};

static void ffmpeg_ctx_release(struct ffmpeg_thread_ctx *ctx) {
    if (atomic_fetch_sub_explicit(&ctx->refcount, 1, memory_order_acq_rel) != 1)
        return;
    if (ctx->argv_owned && ctx->argv) {
        for (int i = 0; i < ctx->argc; i++)
            free(ctx->argv[i]);
        free(ctx->argv);
    }
    free(ctx);
}

static void *ffmpeg_thread_func(void *arg) {
    struct ffmpeg_thread_ctx *ctx = (struct ffmpeg_thread_ctx *)arg;
    // Set thread-local fds on THIS thread (where ffmpeg_main will run)
    noff_stdout_fd = ctx->out_fd;
    noff_stderr_fd = ctx->err_fd;
    ctx->ret = ffmpeg_main(ctx->argc, ctx->argv);
    noff_stdout_fd = -1;
    noff_stderr_fd = -1;
    ffmpeg_ctx_release(ctx);
    return NULL;
}

static int ffmpeg_refuse_poisoned(int stderr_fd) {
    const char *msg =
        "ffmpeg: a previous ffmpeg operation was aborted and its worker "
        "could not be stopped; ffmpeg is unavailable until the app is "
        "restarted\n";
    if (stderr_fd >= 0) (void)!write(stderr_fd, msg, strlen(msg));
    NSLog(@"[FFmpegOffload] refusing invocation — poisoned by an earlier abandoned transcode");
    return 1;
}

static int ffmpeg_handler(int argc, char **argv,
                          int stdin_fd, int stdout_fd, int stderr_fd) {
    if (atomic_load_explicit(&g_ffmpeg_poisoned, memory_order_acquire))
        return ffmpeg_refuse_poisoned(stderr_fd);

    // ── Serialize: only one ffmpeg_main() at a time ──
    // A second FFmpeg request must not become an uninterruptible mutex wait.
    int lockError;
    while ((lockError = pthread_mutex_trylock(&ffmpeg_mutex)) != 0) {
        if (lockError != EBUSY) {
            dprintf(stderr_fd, "ffmpeg: unable to acquire execution lock\n");
            return 1;
        }
        if (noff_is_cancelled()) return 130;
        // A poisoned run holds the mutex forever; fail fast instead of waiting.
        if (atomic_load_explicit(&g_ffmpeg_poisoned, memory_order_acquire))
            return ffmpeg_refuse_poisoned(stderr_fd);
        struct timespec pause = { .tv_sec = 0, .tv_nsec = 50 * NSEC_PER_MSEC };
        nanosleep(&pause, NULL);
    }

    // ── Reset all global state from previous invocation ──
    ffmpeg_reset_globals();

    // ── Save signal handlers ──
    struct sigaction saved_sigint, saved_sigterm, saved_sigpipe;
    sigaction(SIGINT,  NULL, &saved_sigint);
    sigaction(SIGTERM, NULL, &saved_sigterm);
    sigaction(SIGPIPE, NULL, &saved_sigpipe);

    // ── Set custom av_log callback (uses thread-local fds set by the
    //    ffmpeg worker thread; falls back to default if no redirect) ──
    noff_av_log_redirect_start();

    // ── Redirect stdin for ffmpeg's input reading ──
    int saved_stdin = -1;
    if (stdin_fd >= 0) {
        saved_stdin = dup(STDIN_FILENO);
        dup2(stdin_fd, STDIN_FILENO);
    }

    // ── Disable interactive stdin ──
    stdin_interaction = 0;

    // ── Rewrite argv for VideoToolbox compatibility ──
    argc = rewrite_argv_for_videotoolbox(argc, argv);

    // Do not log arguments: paths and media names can contain private data.
    NSLog(@"[FFmpegOffload] starting (argumentCount=%d)", argc);

    // ── Run ffmpeg on a dedicated thread with 8 MB stack ──
    struct ffmpeg_thread_ctx *ctx = calloc(1, sizeof(*ctx));
    if (ctx == NULL) {
        dprintf(stderr_fd, "ffmpeg: out of memory\n");
        noff_av_log_redirect_stop();
        if (saved_stdin >= 0) { dup2(saved_stdin, STDIN_FILENO); close(saved_stdin); }
        pthread_mutex_unlock(&ffmpeg_mutex);
        return 1;
    }
    ctx->argc = argc; ctx->argv = argv;
    ctx->out_fd = stdout_fd; ctx->err_fd = stderr_fd;
    ctx->ret = 1;
    ctx->argv_owned = false;          // exec_handler owns argv unless we abandon
    atomic_init(&ctx->refcount, 2);   // this frame + the worker thread

    pthread_t thr;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 8 * 1024 * 1024);

    int err = pthread_create(&thr, &attr, ffmpeg_thread_func, ctx);
    pthread_attr_destroy(&attr);

    bool cancellationRequested = false;
    bool abandoned = false;
    if (err == 0) {
        // Completion is the worker dropping its ctx reference (Darwin has no
        // pthread_tryjoin_np); the join below then cannot block.
        uint64_t cancelledAt = 0;
        while (atomic_load_explicit(&ctx->refcount, memory_order_acquire) != 1) {
            if (!cancellationRequested && noff_is_cancelled()) {
                cancellationRequested = true;
                cancelledAt = clock_gettime_nsec_np(CLOCK_MONOTONIC);
                ffmpeg_request_cancel();
            }
            if (cancellationRequested &&
                clock_gettime_nsec_np(CLOCK_MONOTONIC) - cancelledAt
                    >= (uint64_t)FFMPEG_CANCEL_GRACE_MS * NSEC_PER_MSEC) {
                abandoned = true;
                break;
            }
            struct timespec pause = { .tv_sec = 0, .tv_nsec = 20 * NSEC_PER_MSEC };
            nanosleep(&pause, NULL);
        }
        if (!abandoned) pthread_join(thr, NULL);
    } else {
        dprintf(stderr_fd, "ffmpeg: unable to create worker thread\n");
        ffmpeg_ctx_release(ctx);   // drop the worker's unused reference
    }

    if (abandoned) {
        // Give the orphan its own argv copy: exec_handler frees argv as soon as
        // we return. Best effort — by the time a transcode can wedge,
        // ffmpeg_main has already parsed argv into its own structures.
        char **copy = calloc((size_t)argc + 1, sizeof(char *));
        if (copy) {
            for (int i = 0; i < argc; i++)
                copy[i] = argv[i] ? strdup(argv[i]) : NULL;
            ctx->argv = copy;
            ctx->argv_owned = true;
        }
        pthread_detach(thr);
        // Poison BEFORE returning so no later caller can race the orphan.
        atomic_store_explicit(&g_ffmpeg_poisoned, true, memory_order_release);
        NSLog(@"[FFmpegOffload] abandoned a wedged ffmpeg_main() %d ms after cancel; "
              @"worker memory is not reclaimed and ffmpeg is disabled until the app restarts",
              FFMPEG_CANCEL_GRACE_MS);
        const char *msg = "\nffmpeg: aborted (worker could not be stopped; "
                          "ffmpeg unavailable until app restart)\n";
        if (stderr_fd >= 0) (void)!write(stderr_fd, msg, strlen(msg));
        // Deliberately skip teardown and keep the mutex held: the orphan still
        // uses the av_log redirect, stdio fds and ffmpeg's globals.
        ffmpeg_ctx_release(ctx);
        return 130;
    }

    // ── Restore av_log callback ──
    noff_av_log_redirect_stop();

    // ── Restore stdin if we redirected it ──
    if (saved_stdin >= 0) {
        dup2(saved_stdin, STDIN_FILENO);
        close(saved_stdin);
    }

    // ── Restore signal handlers ──
    sigaction(SIGINT,  &saved_sigint,  NULL);
    sigaction(SIGTERM, &saved_sigterm, NULL);
    sigaction(SIGPIPE, &saved_sigpipe, NULL);

    pthread_mutex_unlock(&ffmpeg_mutex);

    int ret = cancellationRequested ? 130 : ctx->ret;
    ffmpeg_ctx_release(ctx);
    return ret;
}

void ffmpeg_offload_register(void) {
    int err = native_offload_add_handler("ffmpeg", ffmpeg_handler);
    if (err == 0) {
        NSLog(@"NativeOffloads: ffmpeg handler registered");
    } else {
        NSLog(@"NativeOffloads: failed to register ffmpeg handler (err=%d)", err);
    }
}
