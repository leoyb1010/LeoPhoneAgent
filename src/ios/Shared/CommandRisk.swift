import Foundation

/// How dangerous a shell command looks. Drives the risk badge on approval
/// cards (phone and watch) and the "smart approve" mode, which lets `.low`
/// through and always asks for `.high`.
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
