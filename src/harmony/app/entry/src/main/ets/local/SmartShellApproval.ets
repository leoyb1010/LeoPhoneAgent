/** Mirrors iOS Shared/CommandRisk.swift's narrow SmartShellApproval allowlist. */
export class SmartShellApproval {
  private static readonly highRisk: RegExp[] = [
    /\brm\s+(-\S*\s+)*-\S*[rf]/, /\b(sudo|doas)\b/, /(^|\s)su\s/, /\bmkfs\b/, /\bdd\s+if=/,
    />\s*\/dev\/(sd|disk|nvme|rdisk)/, /\bdiskutil\s+(erase|partition|zero)/, /\beval\b/,
    /\bgit\s+push\b[^;&|]*(\s--force\b|\s-f\b|--force-with-lease)/, /\bgit\s+reset\s+--hard/, /\bgit\s+clean\s+-\S*f/,
    /\bchmod\s+(-r\s+)?(0?777|a\+rwx)/, /\bchown\s+-r\b/, /\b(shutdown|reboot|halt|poweroff)\b/, /\bkillall\b/, /\bkill\s+-9\s+-?1\b/,
    /\blaunchctl\s+(unload|bootout|remove)/, /\bdrop\s+(table|database|schema)\b/, /\btruncate\s+table\b/,
    /\.ssh\//, /\bid_(rsa|ed25519|ecdsa)\b/, /\.aws\/credentials/, /(^|[\s/'"])\.env(\.\w+)?\b/,
    /\b(npm|pnpm|yarn|cargo|gem)\s+publish\b/, /\bpod\s+trunk\s+push\b/, /\bsecurity\s+(delete|dump|find)-\S*password/
  ];
  static readonly gitPrefix: string = 'GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false -c core.untrackedCache=false ';

  static preparedCommand(command: string): string {
    const prepared = command.startsWith('git ') ? SmartShellApproval.gitPrefix + command.substring(4) : command;
    return SmartShellApproval.isReadOnly(prepared) ? prepared : command;
  }

  static isReadOnly(original: string): boolean {
    const safeGit = original.startsWith(SmartShellApproval.gitPrefix);
    const command = safeGit ? 'git ' + original.substring(SmartShellApproval.gitPrefix.length) : original;
    if (!command || !/^[a-zA-Z0-9_./:=+, @%-]+$/.test(command)) return false;
    if (SmartShellApproval.highRisk.some((pattern: RegExp) => pattern.test(command.toLowerCase()))) return false;
    const words = command.split(' ').filter((word: string) => word.length > 0);
    const executable = words[0]; const args = words.slice(1);
    if (['pwd', 'whoami', 'id', 'uptime', 'sw_vers'].indexOf(executable) >= 0) return args.length === 0;
    if (executable === 'uname') return args.length === 0 || (args.length === 1 && ['-a', '-s', '-m'].indexOf(args[0]) >= 0);
    if (executable === 'ls') return SmartShellApproval.safeArguments(args, ['-a', '-l', '-h', '-la', '-al', '-lh', '-lah', '-alh', '-A', '-F', '-R', '-1', '-d', '--']);
    if (executable === 'cat') return SmartShellApproval.safeArguments(args, ['-n', '-b', '-s', '-v', '-E', '-T', '-A', '--']);
    if (executable === 'wc') return SmartShellApproval.safeArguments(args, ['-l', '-w', '-c', '-m', '-L', '--']);
    if (executable === 'head' || executable === 'tail') return args.every((arg: string) => !arg.startsWith('-') || arg === '--' || /^-[0-9]+$/.test(arg));
    if (executable !== 'git' || !safeGit || args[0] !== 'rev-parse' || args.length !== 2) return false;
    return ['HEAD', '--show-toplevel', '--is-inside-work-tree'].indexOf(args[1]) >= 0;
  }

  private static safeArguments(args: string[], flags: string[]): boolean {
    return args.every((arg: string) => !arg.startsWith('-') || flags.indexOf(arg) >= 0);
  }
}
