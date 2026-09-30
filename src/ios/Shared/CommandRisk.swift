import Foundation

/// How dangerous a shell command looks. Drives the risk badge on approval
/// cards (phone and watch). SmartShellApproval applies a separate, narrower
/// execution-bound policy; a `.low` badge alone never authorizes a command.
///
/// Deterministic on purpose (OpenHands' pattern analyzer, OpenCode's
/// defaults): the same command always gets the same answer, and a model can't
/// talk its way down a tier. Compound commands take the highest segment.
/// ponytail: regex table, no parser; a quoted "rm -rf" inside an echo reads as
/// high, which errs on the side of asking.
enum CommandRisk: String, Codable, Comparable, Sendable {
    case low, medium, high

    static func < (lhs: CommandRisk, rhs: CommandRisk) -> Bool {
        lhs.order < rhs.order
    }

    private var order: Int {
        switch self {
        case .low: 0
        case .medium: 1
        case .high: 2
        }
    }

    static func assess(_ command: String) -> CommandRisk {
        // Newlines are separators: collapsing them judged only the first line of a
        // script ("git status\ngit commit -m wip" read as `git status`).
        let text = command.lowercased()
            .replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .medium }
        if matches(text, highPatterns) { return .high }
        // Command substitution runs whatever is inside, whatever the outer command is.
        if text.contains("$(") || text.contains("`") || text.contains("<(") { return .medium }
        // Redirections that write nothing (2>&1, >/dev/null) are not changes,
        // and their "&" must not split the command into a bogus segment.
        let plain = text.replacingOccurrences(of: #"\d*>&\d+|&?\d*>>?\s*/dev/null"#, with: " ",
                                              options: .regularExpression)
        // Split on shell separators; any segment that isn't plainly read-only
        // makes the whole command medium.
        let segments = plain.components(separatedBy: CharacterSet(charactersIn: ";|&\n\r"))
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        if segments.isEmpty { return .medium }
        // Any redirect left writes a file (`2> err.log` too). A ">" inside quotes
        // also lands here — asking once more is the safe side of that line.
        if plain.contains(">") { return .medium }
        return segments.allSatisfy(isReadOnly) ? .low : .medium
    }

    // MARK: - Tables

    private static let highPatterns: [String] = [
        #"\brm\s+(-\S*\s+)*-\S*[rf]"#,                  // rm -rf / -r / -f in any flag position
        #"\b(sudo|doas)\b"#, #"(^|\s)su\s"#,
        #"\bmkfs\b"#, #"\bdd\s+if="#, #">\s*/dev/(sd|disk|nvme|rdisk)"#, #"\bdiskutil\s+(erase|partition|zero)"#,
        #"\b(curl|wget)\b[^;&]*\|\s*(sudo\s+)?(sh|bash|zsh|fish|python3?|perl|ruby|node)\b"#,
        #"\beval\b"#, #"base64\s+(-d|--decode)[^;&]*\|\s*(sh|bash|zsh)"#,
        #"\bgit\s+push\b[^;&|]*(\s--force\b|\s-f\b|--force-with-lease)"#,
        #"\bgit\s+reset\s+--hard"#, #"\bgit\s+clean\s+-\S*f"#,
        #"\bchmod\s+(-r\s+)?(0?777|a\+rwx)"#, #"\bchown\s+-r\b"#,
        #":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:"#,   // fork bomb
        #"\b(shutdown|reboot|halt|poweroff)\b"#, #"\bkillall\b"#, #"\bkill\s+-9\s+-?1\b"#,
        #"\blaunchctl\s+(unload|bootout|remove)"#,
        #"\bdrop\s+(table|database|schema)\b"#, #"\btruncate\s+table\b"#,
        #"\.ssh/"#, #"\bid_(rsa|ed25519|ecdsa)\b"#, #"\.aws/credentials"#, #"(^|[\s/'"])\.env(\.\w+)?\b"#,
        #"(>|\btee\b)\s*/etc/"#,
        #"\b(npm|pnpm|yarn|cargo|gem)\s+publish\b"#, #"\bpod\s+trunk\s+push\b"#,
        #"\bsecurity\s+(delete|dump|find)-\S*password"#,
    ]

    /// Commands that only read. `find` qualifies without -delete / -exec,
    /// `sed` without -i, `git` only for inspection verbs.
    private static let readOnlyCommands: Set<String> = [
        "ls", "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag",
        "pwd", "echo", "printf", "wc", "which", "whoami", "date", "uname", "stat", "file",
        "du", "df", "tree", "sort", "uniq", "cut", "tr", "jq", "yq", "ps", "id", "hostname",
        "diff", "cmp", "basename", "dirname", "realpath", "readlink", "true", "false", "test",
        "type", "man", "whatis", "uptime", "sw_vers", "nl", "column", "xxd", "od",
        "md5", "md5sum", "shasum", "sha256sum", "awk",
    ]
    private static let readOnlyGitVerbs: Set<String> = [
        "status", "diff", "log", "show", "blame", "branch", "remote", "tag", "rev-parse",
        "ls-files", "describe", "shortlog", "grep", "config",
    ]

    private static func isReadOnly(_ segment: String) -> Bool {
        var words = segment.split(separator: " ").map(String.init)
        // Leading env assignments (FOO=1 cmd) and `time`/`nice` wrappers.
        while let first = words.first, first.contains("=") || first == "time" || first == "nice" {
            words.removeFirst()
        }
        guard let command = words.first.map({ ($0 as NSString).lastPathComponent }) else { return true }
        switch command {
        case "git":
            guard let verb = words.dropFirst().first(where: { !$0.hasPrefix("-") }) else { return true }
            if verb == "config" { return !segment.contains(" --global") && words.count <= 3 }
            if verb == "branch" || verb == "tag" || verb == "remote" {
                return words.dropFirst(2).allSatisfy { $0.hasPrefix("-") && !["-d", "-D", "--delete", "-m", "-M"].contains($0) }
                    || words.count == 2
            }
            return readOnlyGitVerbs.contains(verb) && !segment.contains("--output")
        case "find":
            return !words.contains(where: {
                ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"].contains($0)
            })
        case "sed", "yq":
            // -i anywhere in a flag cluster (-Ei, -ni) or --in-place[=suffix] / --inplace.
            return !words.contains(where: { isShortFlagCluster($0, containing: "i") || $0.hasPrefix("--in") })
        case "sort", "tree":
            return !words.contains(where: { isShortFlagCluster($0, containing: "o") || $0.hasPrefix("--output") })
        case "uniq":
            return words.dropFirst().filter { !$0.hasPrefix("-") }.count < 2   // `uniq in out` writes out
        case "awk":
            return !segment.contains("system(")
        default:
            return readOnlyCommands.contains(command)
        }
    }

    private static func isShortFlagCluster(_ word: String, containing flag: Character) -> Bool {
        word.hasPrefix("-") && !word.hasPrefix("--") && word.contains(flag)
    }

    private static func matches(_ text: String, _ patterns: [String]) -> Bool {
        patterns.contains { text.range(of: $0, options: .regularExpression) != nil }
    }
}

/// 授权与风险徽章分离：正则风险标签不能证明 shell 没有副作用。
/// 这里只自动批准很小的单命令语法；解释器、包装器、环境覆盖、重定向、
/// shell 展开和不认识的参数都回到正常审批，不改变逐项/全自动模式。
enum SmartShellApproval {
    // Git 只自动批准下面明确列出的元数据查询。status/ls-files 等工作树检查
    // 即使关闭 fsmonitor 仍可执行 clean/process filter，必须走正常审批。
    // 前缀只是剩余查询的防御层，不能据此把任意 Git 检查当成只读。
    private static let safeGitPrefix = "GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false -c core.untrackedCache=false "

    static func preparedCommand(_ command: String) -> String? {
        let candidate = command.hasPrefix("git ")
            ? safeGitPrefix + command.dropFirst(4) : command
        return isReadOnly(candidate) ? candidate : nil
    }

    static func isReadOnly(_ original: String) -> Bool {
        let safeGit = original.hasPrefix(safeGitPrefix)
        let command = safeGit ? "git " + original.dropFirst(safeGitPrefix.count) : original
        guard CommandRisk.assess(command) == .low,
              !command.isEmpty,
              command.unicodeScalars.allSatisfy({
                  CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./:-=+, @%").contains($0)
              }) else { return false }
        let words = command.split(separator: " ").map(String.init)
        guard let executable = words.first else { return false }
        let args = Array(words.dropFirst())
        // 不接受 /tmp/ls、FOO=...、time/nice 等同名程序或前缀包装。
        switch executable {
        case "pwd", "whoami", "id", "uptime", "sw_vers":
            return args.isEmpty
        case "uname":
            return args.isEmpty || args == ["-a"] || args == ["-s"] || args == ["-m"]
        case "ls":
            return safeArguments(args, flags: ["-a", "-l", "-h", "-la", "-al", "-lh", "-lah", "-alh", "-A", "-F", "-R", "-1", "-d", "--"])
        case "cat":
            return safeArguments(args, flags: ["-n", "-b", "-s", "-v", "-E", "-T", "-A", "--"])
        case "wc":
            return safeArguments(args, flags: ["-l", "-w", "-c", "-m", "-L", "--"])
        case "head", "tail":
            // 仅文件操作数与紧凑的行数参数；不接受 follow、PID 等长寿命选项。
            return args.allSatisfy { arg in
                !arg.hasPrefix("-") || arg == "--" || arg.range(of: #"^-[0-9]+$"#, options: .regularExpression) != nil
            }
        case "git":
            // 不接受 -c/--config-env、别名、输出文件或可执行 diff/textconv 参数。
            guard safeGit, let verb = args.first else { return false }
            let options = Array(args.dropFirst())
            switch verb {
            case "rev-parse": return options == ["HEAD"] || options == ["--show-toplevel"] || options == ["--is-inside-work-tree"]
            default: return false
            }
        default:
            return false
        }
    }

    private static func safeArguments(_ args: [String], flags: Set<String>) -> Bool {
        args.allSatisfy { !$0.hasPrefix("-") || flags.contains($0) }
    }
}
