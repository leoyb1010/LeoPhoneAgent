#include "generated/linux_manifest.h"
#include "generated/linux_packages_manifest.h"
#include "linux_core.h"
#include <cerrno>
#include <cmath>
#include <cstring>
#include <fcntl.h>
#include <limits.h>
#include <napi/native_api.h>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

static std::string string_arg(napi_env env, napi_value value) {
    size_t size = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok) {
        napi_throw_type_error(env, nullptr, "Expected a string argument");
        return {};
    }
    if (size > 32768) {
        napi_throw_range_error(env, nullptr, "Argument is too long");
        return {};
    }
    std::vector<char> bytes(size + 1);
    napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &size);
    if (std::string(bytes.data()).size() != size) {
        napi_throw_type_error(env, nullptr, "NUL in argument");
        return {};
    }
    return std::string(bytes.data(), size);
}
static napi_value integer(napi_env env, int value) {
    napi_value result;
    napi_create_int32(env, value, &result);
    return result;
}
static napi_value undefined(napi_env env) {
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}
static int pid_arg(napi_env env, napi_value value) {
    int32_t pid = 0;
    napi_get_value_int32(env, value, &pid);
    return pid;
}
struct Initialization {
    std::string root, pack, workspace;
    char error[512]{};
    int result = 0;
    bool packages = false;
    napi_deferred deferred;
    napi_async_work work;
};
static napi_value initialize_common(napi_env env, napi_callback_info info, bool packages) {
    napi_value args[3];
    size_t count = 3;
    napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (count != (packages ? 2 : 3)) {
        napi_throw_type_error(env, nullptr, "initialize expects root, pack, workspace");
        return undefined(env);
    }
    auto state = new Initialization();
    state->root = string_arg(env, args[0]);
    state->pack = string_arg(env, args[1]);
    state->packages = packages;
    if (!packages)
        state->workspace = string_arg(env, args[2]);
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (pending) {
        delete state;
        return undefined(env);
    }
    napi_value promise, name;
    napi_create_promise(env, &state->deferred, &promise);
    napi_create_string_utf8(env, "LeoLinuxInitialize", NAPI_AUTO_LENGTH, &name);
    napi_create_async_work(
        env, nullptr, name,
        [](napi_env, void *data) {
            auto state = static_cast<Initialization *>(data);
            if (state->packages) {
                state->result = leo_linux_prepare_packages(state->root.c_str(), state->pack.c_str(),
                                                           state->error, sizeof(state->error));
            } else {
                state->result = leo_linux_initialize(state->root.c_str(), state->pack.c_str(),
                                                     state->workspace.c_str(), state->error,
                                                     sizeof(state->error));
            }
        },
        [](napi_env env, napi_status status, void *data) {
            auto state = static_cast<Initialization *>(data);
            if (status == napi_ok && state->result == 0)
                napi_resolve_deferred(env, state->deferred, undefined(env));
            else {
                napi_value message, error;
                napi_create_string_utf8(env, state->error, NAPI_AUTO_LENGTH, &message);
                napi_create_error(env, nullptr, message, &error);
                napi_reject_deferred(env, state->deferred, error);
            }
            napi_delete_async_work(env, state->work);
            delete state;
        },
        state, &state->work);
    napi_queue_async_work(env, state->work);
    return promise;
}
static napi_value initialize(napi_env env, napi_callback_info info) {
    return initialize_common(env, info, false);
}
static napi_value prepare_packages(napi_env env, napi_callback_info info) {
    return initialize_common(env, info, true);
}
static napi_value packages_hash(napi_env env, napi_callback_info) {
    napi_value value;
    napi_create_string_utf8(env, LINUX_PACKAGES_SHA256, NAPI_AUTO_LENGTH, &value);
    return value;
}
static napi_value start(napi_env env, napi_callback_info info) {
    napi_value args[2];
    size_t count = 2;
    napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (count < 1) {
        napi_throw_type_error(env, nullptr, "Command required");
        return undefined(env);
    }
    std::string command = string_arg(env, args[0]);
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (pending)
        return undefined(env);
    bool interactive = false;
    if (count > 1)
        napi_get_value_bool(env, args[1], &interactive);
    int pid = leo_linux_start(command.c_str(), interactive);
    if (pid <= 0) {
        napi_throw_error(env, nullptr,
                         ("Linux process creation failed: " + std::to_string(pid)).c_str());
        return undefined(env);
    }
    return integer(env, pid);
}
static napi_value start_stdio(napi_env env, napi_callback_info info) {
    napi_value args[1];
    size_t count = 1;
    napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (count != 1) {
        napi_throw_type_error(env, nullptr, "Command required");
        return undefined(env);
    }
    std::string command = string_arg(env, args[0]);
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (pending)
        return undefined(env);
    int pid = leo_linux_start_stdio(command.c_str());
    if (pid <= 0) {
        napi_throw_error(env, nullptr, "Linux stdio process creation failed");
        return undefined(env);
    }
    return integer(env, pid);
}
static napi_value poll(napi_env env, napi_callback_info info) {
    napi_value args[1];
    size_t count = 1;
    napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    int pid = count ? pid_arg(env, args[0]) : 0;
    char errors[65536];
    int stderr_truncated = 0;
    int error_size = leo_linux_poll_stderr(pid, errors, sizeof(errors), &stderr_truncated);
    if (error_size < 0) {
        napi_throw_error(env, nullptr, "Linux process no longer exists");
        return undefined(env);
    }
    char bytes[65536];
    int exited = 0, code = 0, truncated = 0;
    int size = leo_linux_poll(pid, bytes, sizeof(bytes), &exited, &code, &truncated);
    if (size < 0) {
        napi_throw_error(env, nullptr, "Linux process no longer exists");
        return undefined(env);
    }
    napi_value result, buffer, stderr_buffer, done, cut, stderr_cut;
    napi_create_object(env, &result);
    void *target;
    if (napi_create_arraybuffer(env, size, &target, &buffer) != napi_ok)
        return undefined(env);
    if (size)
        memcpy(target, bytes, size);
    napi_set_named_property(env, result, "buffer", buffer);
    if (napi_create_arraybuffer(env, error_size, &target, &stderr_buffer) != napi_ok)
        return undefined(env);
    if (error_size)
        memcpy(target, errors, error_size);
    napi_set_named_property(env, result, "stderrBuffer", stderr_buffer);
    napi_get_boolean(env, stderr_truncated, &stderr_cut);
    napi_set_named_property(env, result, "stderrTruncated", stderr_cut);
    napi_get_boolean(env, exited, &done);
    napi_set_named_property(env, result, "exited", done);
    napi_set_named_property(env, result, "exitCode", integer(env, code));
    napi_get_boolean(env, truncated, &cut);
    napi_set_named_property(env, result, "truncated", cut);
    return result;
}
static napi_value write_input(napi_env env, napi_callback_info info) {
    napi_value args[2];
    size_t count = 2;
    napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (count != 2) {
        napi_throw_type_error(env, nullptr, "write expects pid and text");
        return undefined(env);
    }
    std::string bytes = string_arg(env, args[1]);
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (pending)
        return undefined(env);
    return integer(env, leo_linux_write(pid_arg(env, args[0]), bytes.data(), bytes.size()));
}
static napi_value stop(napi_env env, napi_callback_info info) {
    napi_value args[1];
    size_t count = 1;
    napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    return integer(env, count ? leo_linux_stop(pid_arg(env, args[0])) : -1);
}
static napi_value resize(napi_env env, napi_callback_info info) {
    napi_value args[3];
    size_t count = 3;
    napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    return integer(env, count == 3 ? leo_linux_resize(pid_arg(env, args[0]), pid_arg(env, args[1]),
                                                      pid_arg(env, args[2]))
                                   : -1);
}
static napi_value pack_hash(napi_env env, napi_callback_info) {
    napi_value value;
    napi_create_string_utf8(env, LINUX_PACK_SHA256, NAPI_AUTO_LENGTH, &value);
    return value;
}
// Trusted ArkTS manual imports supply an already pinned workspace directory.
// This helper preserves atomic exclusive-create semantics absent from CoreFileKit.
static napi_value create_workspace_file(napi_env env, napi_callback_info info) {
    napi_value args[3];
    size_t count = 3, length = 0, written = 0;
    double parent = -1;
    if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 2 ||
        napi_get_value_double(env, args[0], &parent) != napi_ok || !std::isfinite(parent) ||
        parent < 0 || parent > INT_MAX || std::floor(parent) != parent ||
        napi_get_value_string_utf8(env, args[1], nullptr, 0, &length) != napi_ok)
        return integer(env, -EINVAL);
    if (length == 0 || length > NAME_MAX)
        return integer(env, length > NAME_MAX ? -ENAMETOOLONG : -EINVAL);
    char basename[NAME_MAX + 1];
    if (napi_get_value_string_utf8(env, args[1], basename, sizeof(basename), &written) != napi_ok ||
        written != length || memchr(basename, '\0', length) || memchr(basename, '/', length) ||
        !strcmp(basename, ".") || !strcmp(basename, ".."))
        return integer(env, -EINVAL);
    struct stat directory;
    int parent_fd = static_cast<int>(parent);
    if (fstat(parent_fd, &directory) < 0)
        return integer(env, -errno);
    if (!S_ISDIR(directory.st_mode))
        return integer(env, -ENOTDIR);
    int fd = openat(parent_fd, basename, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    return integer(env, fd < 0 ? -errno : fd);
}

static napi_value register_module(napi_env env, napi_value exports) {
    napi_property_descriptor properties[] = {
        {"createWorkspaceFile", nullptr, create_workspace_file, nullptr, nullptr, nullptr,
         napi_default, nullptr},
        {"initialize", nullptr, initialize, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"preparePackages", nullptr, prepare_packages, nullptr, nullptr, nullptr, napi_default,
         nullptr},
        {"packagesHash", nullptr, packages_hash, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"start", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"startStdio", nullptr, start_stdio, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"poll", nullptr, poll, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"write", nullptr, write_input, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stop", nullptr, stop, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"resize", nullptr, resize, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"packHash", nullptr, pack_hash, nullptr, nullptr, nullptr, napi_default, nullptr}};
    napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
    return exports;
}
static napi_module module = {1, 0, nullptr, register_module, "leolinux", nullptr, {0}};
extern "C" __attribute__((constructor)) void RegisterLeoLinux() { napi_module_register(&module); }
