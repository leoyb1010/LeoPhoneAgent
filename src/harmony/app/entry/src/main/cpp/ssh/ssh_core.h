#pragma once
#include <string>
#include <vector>
struct SSHOptions {
    SSHOptions() = default;
    SSHOptions(SSHOptions &&) = default;
    SSHOptions &operator=(SSHOptions &&) = default;
    SSHOptions(const SSHOptions &) = delete;
    SSHOptions &operator=(const SSHOptions &) = delete;
    std::string owner, host, user, host_key;
    int port = 22;
    std::vector<char> private_key, passphrase, password;
    ~SSHOptions();
};
struct SSHOutput {
    std::string text, state, error, fingerprint;
    bool truncated = false;
    int exit_code = 0;
};
int ssh_start(SSHOptions options);
SSHOutput ssh_poll(int id, const std::string &owner);
int ssh_write(int id, const std::string &owner, const std::string &text);
void ssh_resize(int id, const std::string &owner, int columns, int rows);
void ssh_stop(int id, const std::string &owner);

// Discard a handle only when its owner has left and will never poll again.
void ssh_abandon(int id, const std::string &owner);
