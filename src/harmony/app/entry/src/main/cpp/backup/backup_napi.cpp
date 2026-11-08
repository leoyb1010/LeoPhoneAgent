#include <napi/native_api.h>
#include <filemanagement/archive/oh_archive.h>
#include <algorithm>
#include <atomic>
#include <cstdio>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
struct PackJob {
    std::string token, destination, error;
    std::vector<std::string> sources;
    std::atomic<bool> cancelled{false};
    std::atomic<int> percent{0};
    napi_async_work work = nullptr;
    napi_deferred deferred = nullptr;
};
std::mutex jobs_mutex;
std::map<std::string, std::shared_ptr<PackJob>> jobs;
std::string text(napi_env env, napi_value input) {
    size_t size = 0;
    if (napi_get_value_string_utf8(env, input, nullptr, 0, &size) != napi_ok || !size || size > 4096)
        throw std::runtime_error("备份参数无效");
    std::string result(size + 1, '\0');
    napi_get_value_string_utf8(env, input, result.data(), result.size(), &size);
    result.resize(size);
    if (result.find('\0') != std::string::npos) throw std::runtime_error("备份参数包含NUL");
    return result;
}
napi_value undefined(napi_env env) { napi_value value; napi_get_undefined(env, &value); return value; }
OH_Archive_ProgressType report(int32_t percent, void *data) {
    auto job = static_cast<PackJob *>(data);
    job->percent = std::clamp(percent, 0, 100);
    return job->cancelled ? OH_ARCHIVE_PROGRESS_CANCEL : OH_ARCHIVE_PROGRESS_CONTINUE;
}
void execute(napi_env, void *data) {
    auto job = static_cast<PackJob *>(data);
    if (job->cancelled) { job->error = "备份已取消"; return; }
    auto archive = OH_Archive_Writer_OpenFile(job->destination.c_str(), OH_ARCHIVE_OPEN_MODE_CREATE, OH_ARCHIVE_FMT_ZIP);
    if (!archive) { job->error = "无法创建备份ZIP"; return; }
    std::vector<const char *> sources;
    for (const auto &source : job->sources) sources.push_back(source.c_str());
    const auto callback = OH_Archive_Writer_SetProgressHandlerWithData(archive, report, job);
    const auto method = OH_Archive_Writer_SetCompressMethod(archive, OH_ARCHIVE_NO_COMPRESSION, 0);
    const auto result = callback == OH_ARCHIVE_OK && method == OH_ARCHIVE_OK && !job->cancelled
        ? OH_Archive_Writer_Add(archive, sources.data(), sources.size()) : OH_ARCHIVE_PARAM_ERROR;
    const auto closed = OH_Archive_Writer_Close(archive);
    if (job->cancelled) job->error = "备份已取消";
    else if (result != OH_ARCHIVE_OK || closed != OH_ARCHIVE_OK) job->error = "原生ZIP封装失败";
    if (!job->error.empty()) std::remove(job->destination.c_str());
}
void complete(napi_env env, napi_status status, void *data) {
    auto raw = static_cast<PackJob *>(data);
    std::shared_ptr<PackJob> job;
    { std::lock_guard<std::mutex> lock(jobs_mutex); job = jobs.at(raw->token); jobs.erase(raw->token); }
    napi_value value;
    if (status != napi_ok && job->error.empty()) job->error = "备份任务中断";
    if (job->cancelled && job->error.empty()) { job->error = "备份已取消"; std::remove(job->destination.c_str()); }
    if (job->error.empty()) napi_resolve_deferred(env, job->deferred, undefined(env));
    else {
        napi_value message; napi_create_string_utf8(env, job->error.c_str(), NAPI_AUTO_LENGTH, &message);
        napi_create_error(env, nullptr, message, &value); napi_reject_deferred(env, job->deferred, value);
    }
    napi_delete_async_work(env, job->work);
}
napi_value pack(napi_env env, napi_callback_info info) {
    std::shared_ptr<PackJob> job;
    bool registered = false;
    try {
        size_t count = 3; napi_value args[3]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 3) throw std::runtime_error("备份封装参数不完整");
        job = std::make_shared<PackJob>(); job->token = text(env, args[0]); job->destination = text(env, args[1]);
        uint32_t length = 0;
        if (napi_get_array_length(env, args[2], &length) != napi_ok || !length || length > 16)
            throw std::runtime_error("备份封装来源无效");
        for (uint32_t i = 0; i < length; ++i) { napi_value item; napi_get_element(env, args[2], i, &item); job->sources.push_back(text(env, item)); }
        { std::lock_guard<std::mutex> lock(jobs_mutex);
          if (!jobs.empty()) throw std::runtime_error("已有备份正在封装");
          jobs[job->token] = job; registered = true; }
        napi_value promise, name;
        napi_create_promise(env, &job->deferred, &promise);
        napi_create_string_utf8(env, "LeoBackupPack", NAPI_AUTO_LENGTH, &name);
        if (napi_create_async_work(env, nullptr, name, execute, complete, job.get(), &job->work) != napi_ok ||
            napi_queue_async_work(env, job->work) != napi_ok) throw std::runtime_error("无法启动备份工作线程");
        return promise;
    } catch (const std::exception &error) {
        if (job && registered) { std::lock_guard<std::mutex> lock(jobs_mutex); jobs.erase(job->token); if (job->work) napi_delete_async_work(env, job->work); }
        napi_throw_error(env, nullptr, error.what()); return undefined(env);
    }
}
napi_value control(napi_env env, napi_callback_info info, bool cancel) {
    try {
        size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 1) throw std::runtime_error("备份任务标识缺失");
        const auto token = text(env, args[0]);
        std::lock_guard<std::mutex> lock(jobs_mutex); const auto found = jobs.find(token);
        int percent = -1;
        if (found != jobs.end()) { if (cancel) found->second->cancelled = true; percent = found->second->percent; }
        napi_value result; napi_create_int32(env, percent, &result); return result;
    } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return undefined(env); }
}
napi_value progress(napi_env env, napi_callback_info info) { return control(env, info, false); }
napi_value cancel(napi_env env, napi_callback_info info) { return control(env, info, true); }
napi_value init(napi_env env, napi_value exports) {
    napi_property_descriptor methods[] = {
        {"pack", nullptr, pack, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"progress", nullptr, progress, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"cancel", nullptr, cancel, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods); return exports;
}
napi_module module = {1, 0, nullptr, init, "leobackup", nullptr, {0}};
}
extern "C" __attribute__((constructor)) void RegisterLeoBackup() { napi_module_register(&module); }
