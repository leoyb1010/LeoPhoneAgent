#include "ssh_core.h"
#include <napi/native_api.h>
#include <openssl/crypto.h>
#include <stdexcept>
#include <cstring>
#include <utility>

namespace {
napi_value undefined(napi_env env) { napi_value value; napi_get_undefined(env, &value); return value; }
std::string text(napi_env env, napi_value value, size_t maximum = 16384, bool reject_nul = true) {
    size_t length = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length > maximum)
        throw std::runtime_error("SSH字符串参数无效或过长");
    std::string result(length + 1, '\0');
    napi_get_value_string_utf8(env, value, result.data(), result.size(), &length);
    result.resize(length);
    if (reject_nul && result.find('\0') != std::string::npos) throw std::runtime_error("SSH参数含非法控制字符");
    return result;
}
napi_value property(napi_env env, napi_value object, const char *name) {
    napi_value value;
    if (napi_get_named_property(env, object, name, &value) != napi_ok) throw std::runtime_error("SSH连接参数缺失");
    return value;
}
std::vector<char> secret(napi_env env, napi_value object, const char *name) {
    napi_value value = property(env, object, name); size_t size = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok || size > 65536)
        throw std::runtime_error("SSH凭据格式无效");
    if (!size) return {};
    std::vector<char> bytes(size + 1, 0);
    napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &size);
    if (std::char_traits<char>::length(bytes.data()) != size) {
        OPENSSL_cleanse(bytes.data(), bytes.size()); throw std::runtime_error("SSH凭据含非法控制字符");
    }
    return bytes;
}
int number(napi_env env, napi_value value) {
    int32_t result = 0; if (napi_get_value_int32(env, value, &result) != napi_ok) throw std::runtime_error("SSH数字参数无效"); return result;
}
napi_value integer(napi_env env, int value) { napi_value result; napi_create_int32(env, value, &result); return result; }
void string_property(napi_env env, napi_value object, const char *name, const std::string &text) {
    napi_value value; napi_create_string_utf8(env, text.data(), text.size(), &value); napi_set_named_property(env, object, name, value);
}
napi_value start(napi_env env, napi_callback_info info) {
    try {
        size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 1) throw std::runtime_error("SSH连接需要一个参数对象");
        SSHOptions options;
        options.owner = text(env, property(env, args[0], "owner"), 128);
        options.host = text(env, property(env, args[0], "host"), 253);
        options.user = text(env, property(env, args[0], "username"), 128);
        options.host_key = text(env, property(env, args[0], "hostKey"));
        options.port = number(env, property(env, args[0], "port"));
        options.private_key = secret(env, args[0], "privateKey");
        options.passphrase = secret(env, args[0], "passphrase");
        options.password = secret(env, args[0], "password");
        return integer(env, ssh_start(std::move(options)));
    } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return undefined(env); }
}
napi_value poll(napi_env env, napi_callback_info info) {
    try {
        size_t count = 2; napi_value args[2]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 2) throw std::runtime_error("SSH轮询参数不完整");
        auto output = ssh_poll(number(env, args[0]), text(env, args[1], 128));
        napi_value result; napi_create_object(env, &result);
        napi_value bytes; void *memory = nullptr;
        napi_create_arraybuffer(env, output.text.size(), &memory, &bytes);
        if (!output.text.empty()) std::memcpy(memory, output.text.data(), output.text.size());
        napi_set_named_property(env, result, "buffer", bytes);
        string_property(env, result, "state", output.state);
        string_property(env, result, "error", output.error); string_property(env, result, "fingerprint", output.fingerprint);
        napi_set_named_property(env, result, "exitCode", integer(env, output.exit_code));
        napi_value truncated; napi_get_boolean(env, output.truncated, &truncated); napi_set_named_property(env, result, "truncated", truncated);
        return result;
    } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return undefined(env); }
}
napi_value write(napi_env env, napi_callback_info info) {
    try {
        size_t count = 3; napi_value args[3]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 3) throw std::runtime_error("SSH输入参数不完整");
        return integer(env, ssh_write(number(env, args[0]), text(env, args[1], 128), text(env, args[2], 4096, false)));
    } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return undefined(env); }
}
napi_value resize(napi_env env, napi_callback_info info) {
    try {
        size_t count = 4; napi_value args[4]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 4) throw std::runtime_error("SSH终端尺寸参数不完整");
        ssh_resize(number(env, args[0]), text(env, args[1], 128), number(env, args[2]), number(env, args[3]));
    } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); }
    return undefined(env);
}
napi_value stop(napi_env env, napi_callback_info info) {
    try {
        size_t count = 2; napi_value args[2]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 2) throw std::runtime_error("SSH停止参数不完整");
        ssh_abandon(number(env, args[0]), text(env, args[1], 128));
    } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); }
    return undefined(env);
}
napi_value init(napi_env env, napi_value exports) {
    napi_property_descriptor methods[] = {
        {"start", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"poll", nullptr, poll, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"write", nullptr, write, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"resize", nullptr, resize, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stop", nullptr, stop, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
    return exports;
}
napi_module module = {1, 0, nullptr, init, "leossh", nullptr, {0}};
}
extern "C" __attribute__((constructor)) void RegisterLeoSSH() { napi_module_register(&module); }
