#include "ssh_core.h"
#include <libssh2.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/sha.h>
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <fcntl.h>
#include <map>
#include <memory>
#include <mutex>
#include <netdb.h>
#include <poll.h>
#include <stdexcept>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>

namespace {
void wipe(std::vector<char> &value) { if (!value.empty()) OPENSSL_cleanse(value.data(), value.size()); value.clear(); }
struct Session {
    SSHOptions options;
    std::mutex mutex, socket_mutex;
    std::atomic<bool> cancelled{false};
    int socket = -1, id = 0, columns = 100, rows = 32;
    bool resize_pending = false, finished = false;
    std::string input, output, state = "connecting", error, fingerprint;
    bool truncated = false;
    int exit_code = 0;
};
std::mutex registry_mutex;
std::map<int, std::shared_ptr<Session>> registry;
std::atomic<int> next_id{1};
std::atomic<int> active_workers{0};
std::once_flag initialized;
std::shared_ptr<Session> owned(int id, const std::string &owner) {
    std::lock_guard<std::mutex> lock(registry_mutex);
    auto found = registry.find(id);
    if (found == registry.end() || owner.empty() || found->second->options.owner != owner)
        throw std::runtime_error("SSH会话不存在或属于另一窗口");
    return found->second;
}
void append(Session &session, const char *data, size_t size) {
    std::lock_guard<std::mutex> lock(session.mutex);
    session.output.append(data, size);
    if (session.output.size() > 256 * 1024) {
        session.output.erase(0, session.output.size() - 256 * 1024);
        session.truncated = true;
    }
}
void cancelled(Session &session) { if (session.cancelled) throw std::runtime_error("SSH连接已取消"); }
void close_socket(Session &session) {
    std::lock_guard<std::mutex> lock(session.socket_mutex);
    if (session.socket >= 0) { ::close(session.socket); session.socket = -1; }
}
int connect_socket(Session &session) {
    addrinfo hints{}; hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM; hints.ai_flags = AI_NUMERICHOST;
    addrinfo *addresses = nullptr;
    const std::string port = std::to_string(session.options.port);
    if (getaddrinfo(session.options.host.c_str(), port.c_str(), &hints, &addresses) != 0)
        throw std::runtime_error("SSH主机名解析失败");
    std::unique_ptr<addrinfo, decltype(&freeaddrinfo)> cleanup(addresses, freeaddrinfo);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
    for (auto address = addresses; address; address = address->ai_next) {
        cancelled(session);
        int descriptor = ::socket(address->ai_family, address->ai_socktype, address->ai_protocol);
        if (descriptor < 0) continue;
        {
            std::lock_guard<std::mutex> lock(session.socket_mutex);
            session.socket = descriptor;
        }
        fcntl(descriptor, F_SETFD, FD_CLOEXEC);
        fcntl(descriptor, F_SETFL, O_NONBLOCK);
        int result = ::connect(descriptor, address->ai_addr, address->ai_addrlen);
        while (result < 0 && errno == EINPROGRESS && std::chrono::steady_clock::now() < deadline) {
            cancelled(session);
            pollfd ready{descriptor, POLLOUT, 0};
            if (::poll(&ready, 1, 100) <= 0) continue;
            int error = 0; socklen_t length = sizeof(error);
            getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &error, &length);
            if (error) { errno = error; break; }
            result = 0;
        }
        if (result == 0) {
            fcntl(descriptor, F_SETFL, 0);
            timeval timeout{15, 0};
            setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
            setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
            return descriptor;
        }
        close_socket(session);
    }
    throw std::runtime_error("SSH连接失败或超过15秒");
}
std::string fingerprint(const char *key, size_t size) {
    unsigned char digest[SHA256_DIGEST_LENGTH]; SHA256(reinterpret_cast<const unsigned char *>(key), size, digest);
    unsigned char encoded[64]; const int length = EVP_EncodeBlock(encoded, digest, sizeof(digest));
    std::string value(reinterpret_cast<char *>(encoded), length);
    while (!value.empty() && value.back() == '=') value.pop_back();
    return "SHA256:" + value;
}
void verify_key(Session &session, LIBSSH2_SESSION *ssh) {
    size_t size = 0; int type = 0;
    const char *key = libssh2_session_hostkey(ssh, &size, &type);
    if (!key || !size) throw std::runtime_error("SSH服务器没有提供主机公钥");
    std::string pin = session.options.host_key;
    size_t begin = pin.find(' '), end = pin.find(' ', begin + 1);
    if (begin == std::string::npos) throw std::runtime_error("请先保存并核实SSH主机公钥");
    std::string base64 = pin.substr(begin + 1, end == std::string::npos ? end : end - begin - 1);
    std::vector<unsigned char> decoded(base64.size());
    int length = EVP_DecodeBlock(decoded.data(), reinterpret_cast<const unsigned char *>(base64.data()), base64.size());
    if (length < 0) throw std::runtime_error("SSH主机公钥格式无效");
    if (!base64.empty() && base64.back() == '=') --length;
    if (base64.size() > 1 && base64[base64.size() - 2] == '=') --length;
    const auto actual = fingerprint(key, size);
    { std::lock_guard<std::mutex> lock(session.mutex); session.fingerprint = actual; }
    if (static_cast<size_t>(length) != size || CRYPTO_memcmp(decoded.data(), key, size) != 0)
        throw std::runtime_error("SSH主机公钥不匹配，连接已终止。当前指纹 " + actual);
}
const char *credential(const std::vector<char> &value) { return value.empty() ? "" : value.data(); }
static LIBSSH2_SEND_FUNC(safe_send) { return ::send(socket, buffer, length, flags | MSG_NOSIGNAL); }
void worker(std::shared_ptr<Session> session) {
    LIBSSH2_SESSION *ssh = nullptr; LIBSSH2_CHANNEL *channel = nullptr;
    try {
        const int descriptor = connect_socket(*session);
        cancelled(*session);
        ssh = libssh2_session_init();
        if (!ssh) throw std::runtime_error("SSH运行时初始化失败");
        libssh2_session_set_timeout(ssh, 15000);
        libssh2_session_callback_set2(ssh, LIBSSH2_CALLBACK_SEND, reinterpret_cast<libssh2_cb_generic *>(safe_send));
        if (libssh2_session_handshake(ssh, descriptor) != 0) throw std::runtime_error("SSH握手失败");
        cancelled(*session);
        verify_key(*session, ssh);
        cancelled(*session);
        int result;
        if (!session->options.private_key.empty()) {
            result = libssh2_userauth_publickey_frommemory(ssh, session->options.user.c_str(), session->options.user.size(),
                nullptr, 0, credential(session->options.private_key), session->options.private_key.size() - 1,
                credential(session->options.passphrase));
        } else {
            result = libssh2_userauth_password(ssh, session->options.user.c_str(), credential(session->options.password));
        }
        wipe(session->options.private_key); wipe(session->options.passphrase); wipe(session->options.password);
        if (result != 0) throw std::runtime_error("SSH身份认证失败，请检查密钥、口令或服务器授权");
        cancelled(*session);
        channel = libssh2_channel_open_session(ssh);
        if (!channel) throw std::runtime_error("SSH终端通道创建失败");
        if (libssh2_channel_request_pty_ex(channel, "xterm-256color", 14, nullptr, 0, 100, 32, 0, 0) != 0 ||
            libssh2_channel_shell(channel) != 0) throw std::runtime_error("SSH服务器未允许交互终端");
        fcntl(descriptor, F_SETFL, O_NONBLOCK);
        libssh2_session_set_blocking(ssh, 0);
        { std::lock_guard<std::mutex> lock(session->mutex); session->state = "connected"; }
        char buffer[8192];
        while (!session->cancelled) {
            for (int stream = 0; stream < 2; ++stream) {
                ssize_t count;
                while ((count = libssh2_channel_read_ex(channel, stream, buffer, sizeof(buffer))) > 0)
                    append(*session, buffer, count);
                if (count < 0 && count != LIBSSH2_ERROR_EAGAIN && libssh2_channel_eof(channel) != 1) throw std::runtime_error("SSH终端读取中断");
            }
            {
                std::lock_guard<std::mutex> lock(session->mutex);
                if (!session->input.empty()) {
                    ssize_t count = libssh2_channel_write(channel, session->input.data(), session->input.size());
                    if (count > 0) session->input.erase(0, count);
                    else if (count != LIBSSH2_ERROR_EAGAIN && count < 0) throw std::runtime_error("SSH终端写入失败");
                }
                if (session->resize_pending && libssh2_channel_request_pty_size(channel, session->columns, session->rows) == 0)
                    session->resize_pending = false;
            }
            if (libssh2_channel_eof(channel)) break;
            pollfd ready{descriptor, POLLIN, 0}; ::poll(&ready, 1, 40);
        }
        { std::lock_guard<std::mutex> lock(session->mutex); session->exit_code = libssh2_channel_get_exit_status(channel); }
    } catch (const std::exception &error) {
        std::lock_guard<std::mutex> lock(session->mutex); session->error = error.what();
    }
    wipe(session->options.private_key); wipe(session->options.passphrase); wipe(session->options.password);
    // Shutdown first so cleanup cannot wait on remote network IO.
    { std::lock_guard<std::mutex> lock(session->socket_mutex); if (session->socket >= 0) ::shutdown(session->socket, SHUT_RDWR); }
    if (ssh) { libssh2_session_set_blocking(ssh, 1); libssh2_session_set_timeout(ssh, 500); }
    if (channel) libssh2_channel_free(channel);
    if (ssh) libssh2_session_free(ssh);
    close_socket(*session);
    {
        std::lock_guard<std::mutex> lock(session->mutex);
        OPENSSL_cleanse(session->input.data(), session->input.size()); session->input.clear();
        session->state = session->cancelled ? "cancelled" : session->error.empty() ? "exited" : "failed";
        session->finished = true;
    }
    --active_workers;
}
}
SSHOptions::~SSHOptions() { wipe(private_key); wipe(passphrase); wipe(password); }
int ssh_start(SSHOptions options) {
    std::call_once(initialized, [] { if (libssh2_init(0) != 0) throw std::runtime_error("SSH库初始化失败"); });
    if (options.owner.empty() || options.host.empty() || options.host.size() > 253 || options.user.empty() ||
        options.port < 1 || options.port > 65535 || options.host_key.empty()) throw std::runtime_error("SSH连接参数不完整");
    auto session = std::make_shared<Session>(); session->options = std::move(options);
    session->id = next_id++;
    { std::lock_guard<std::mutex> lock(registry_mutex);
      // Retain completed output until its owner polls or explicitly abandons the handle.
      if (registry.size() >= 4 || active_workers >= 4) throw std::runtime_error("最多同时打开4个SSH终端，请等待停止中的连接完成清理");
      registry[session->id] = session; ++active_workers; }
    try { std::thread(worker, session).detach(); }
    catch (...) { --active_workers; std::lock_guard<std::mutex> lock(registry_mutex); registry.erase(session->id); throw; }
    return session->id;
}
SSHOutput ssh_poll(int id, const std::string &owner) {
    auto session = owned(id, owner); SSHOutput output; bool finished;
    { std::lock_guard<std::mutex> lock(session->mutex); output.text.swap(session->output); output.state = session->state;
      output.error = session->error; output.fingerprint = session->fingerprint; output.exit_code = session->exit_code;
      output.truncated = session->truncated; session->truncated = false; finished = session->finished; }
    if (finished) { std::lock_guard<std::mutex> lock(registry_mutex); registry.erase(id); }
    return output;
}
int ssh_write(int id, const std::string &owner, const std::string &text) {
    auto session = owned(id, owner); std::lock_guard<std::mutex> lock(session->mutex);
    if (session->state != "connected" || session->cancelled) throw std::runtime_error("SSH终端尚未连接");
    if (text.size() > 4096 || session->input.size() + text.size() > 16384) throw std::runtime_error("SSH输入队列已满，请稍后重试");
    session->input += text; return text.size();
}
void ssh_resize(int id, const std::string &owner, int columns, int rows) {
    auto session = owned(id, owner); std::lock_guard<std::mutex> lock(session->mutex);
    session->columns = std::clamp(columns, 20, 400); session->rows = std::clamp(rows, 5, 200); session->resize_pending = true;
}
void ssh_stop(int id, const std::string &owner) {
    auto session = owned(id, owner); session->cancelled = true;
    std::lock_guard<std::mutex> lock(session->socket_mutex); if (session->socket >= 0) ::shutdown(session->socket, SHUT_RDWR);
}

void ssh_abandon(int id, const std::string &owner) {
    auto session = owned(id, owner);
    session->cancelled = true;
    {
        std::lock_guard<std::mutex> lock(session->socket_mutex);
        if (session->socket >= 0) ::shutdown(session->socket, SHUT_RDWR);
    }
    // The worker owns its shared_ptr until native resources have been cleaned up.
    std::lock_guard<std::mutex> lock(registry_mutex);
    registry.erase(id);
}
