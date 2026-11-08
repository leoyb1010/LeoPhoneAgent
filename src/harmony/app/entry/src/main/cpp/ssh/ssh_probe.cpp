// Ephemeral local fixture probe. Credentials use stdin or a loopback-only in-memory fixture endpoint, never argv or files.
#include "ssh_core.h"
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <termios.h>
#include <unistd.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <openssl/crypto.h>
std::string fixture_credential(int port, const std::string &mode) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in target{}; target.sin_family = AF_INET; target.sin_port = htons(port); inet_pton(AF_INET, "127.0.0.1", &target.sin_addr);
    if (connect(fd, reinterpret_cast<sockaddr *>(&target), sizeof(target)) != 0) throw std::runtime_error("fixture credential endpoint unavailable");
    const std::string request = "GET /" + (mode == "key" ? std::string("key") : std::string("password")) + " HTTP/1.0\r\nHost: localhost\r\n\r\n";
    send(fd, request.data(), request.size(), 0);
    std::string response; char buffer[4096]; ssize_t count;
    while ((count = recv(fd, buffer, sizeof(buffer), 0)) > 0 && response.size() < 131072) response.append(buffer, count);
    close(fd);
    const auto header = response.find("\r\n\r\n");
    if (header == std::string::npos) throw std::runtime_error("invalid fixture credential response");
    std::string result = response.substr(header + 4); OPENSSL_cleanse(response.data(), response.size()); return result;
}
int main(int argc, char **argv) {
    if (argc != 5 && argc != 6) return 64;
    SSHOptions options; options.owner = "fixture-owner"; options.host = argv[1]; options.port = std::stoi(argv[2]);
    options.user = "fixture"; options.host_key = argv[3]; std::string mode = argv[4];
    termios term{};
    if (isatty(STDIN_FILENO) && tcgetattr(STDIN_FILENO, &term) == 0) { term.c_lflag &= ~ECHO; tcsetattr(STDIN_FILENO, TCSANOW, &term); }
    std::cout << "SSH_PROBE_READY" << std::endl;
    std::string credential, line;
    if (argc == 6) credential = fixture_credential(std::stoi(argv[5]), mode);
    else while (std::getline(std::cin, line) && line != "LEO_FIXTURE_END") credential += line + "\n";
    if (mode == "key") { options.private_key.assign(credential.begin(), credential.end()); options.private_key.push_back(0); }
    else { if (!credential.empty()) credential.pop_back(); options.password.assign(credential.begin(), credential.end()); options.password.push_back(0); }
    std::fill(credential.begin(), credential.end(), '\0');
    try {
        const int id = ssh_start(std::move(options));
        if (mode == "cancel") { std::this_thread::sleep_for(std::chrono::milliseconds(80)); ssh_stop(id, "fixture-owner"); }
        const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(20);
        bool sent = false, received = false, ownership = false;
        std::string output;
        while (std::chrono::steady_clock::now() < end) {
            auto frame = ssh_poll(id, "fixture-owner"); output += frame.text;
            if (frame.state == "connected" && !sent) {
                try { ssh_write(id, "different-owner", "malicious"); } catch (...) { ownership = true; }
                ssh_resize(id, "fixture-owner", 120, 40);
                ssh_write(id, "fixture-owner", mode == "retention" ? "fixture-retention\n" : "fixture-command\n");
                sent = true;
                if (mode == "retention") {
                    // Leave A's final output unpolled until its worker finishes, then start B.
                    std::this_thread::sleep_for(std::chrono::milliseconds(1000));
                    SSHOptions other;
                    other.owner = "different-owner"; other.host = argv[1]; other.port = std::stoi(argv[2]);
                    other.user = "fixture"; other.host_key = argv[3];
                    const int second = ssh_start(std::move(other));
                    bool rejected = false;
                    try { ssh_abandon(id, "different-owner"); } catch (...) { rejected = true; }
                    if (!rejected) throw std::runtime_error("another owner discarded final output");
                    ssh_abandon(second, "different-owner");
                }
            }
            if (output.find("SSH_FIXTURE_OK") != std::string::npos) received = true;
            if (frame.state == "failed" || frame.state == "exited" || frame.state == "cancelled") {
                const bool ok = mode == "mismatch" ? frame.error.find("公钥不匹配") != std::string::npos :
                    mode == "cancel" ? frame.state == "cancelled" : frame.state == "exited" && received && ownership && frame.exit_code == (mode == "retention" ? 23 : 0);
                std::cout << (ok ? "SSH_PROBE_OK " : "SSH_PROBE_FAILED ") << mode << " " << frame.state << (ok ? "" : " " + frame.error) << std::endl;
                return ok ? 0 : 1;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(30));
        }
        ssh_stop(id, "fixture-owner"); std::cerr << "SSH_PROBE_TIMEOUT" << std::endl; return 2;
    } catch (const std::exception &error) { std::cerr << "SSH_PROBE_ERROR " << error.what() << std::endl; return 1; }
}
