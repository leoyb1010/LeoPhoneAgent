/** Minimal token shape shared by the platform wrapper readers. */
interface ShellToken {
  text: string;
  end: number;
}

/** POSIX token metadata used to distinguish safe quoting from mixed shell text. */
interface PosixShellToken extends ShellToken {
  /** True when at least one part of the shell word was quoted. */
  quoted: boolean;
  /** Literal characters outside quotes make a quoted wrapper script ambiguous. */
  hasUnquotedLiteral: boolean;
}

function readShellToken(input: string, start: number): ShellToken | null {
  let index = start;
  while (index < input.length && /\s/.test(input[index])) index += 1;
  if (index >= input.length) return null;

  const quote = input[index];
  if (quote === '"' || quote === "'") {
    index += 1;
    let text = '';
    while (index < input.length) {
      const ch = input[index];
      if (ch === quote) {
        if (quote === "'" && input[index + 1] === "'") {
          text += "'";
          index += 2;
          continue;
        }
        return { text, end: index + 1 };
      }
      if (quote === '"' && ch === '\\' && input[index + 1] === '"') {
        text += '"';
        index += 2;
        continue;
      }
      if (quote === '"' && ch === '`' && input[index + 1] === quote) {
        text += input[index + 1];
        index += 2;
        continue;
      }
      text += ch;
      index += 1;
    }
    return null;
  }

  const tokenStart = index;
  while (index < input.length && !/\s/.test(input[index])) index += 1;
  return { text: input.slice(tokenStart, index), end: index };
}

function readCommandRemainder(input: string, start: number): ShellToken | null {
  let index = start;
  while (index < input.length && /\s/.test(input[index])) index += 1;
  if (index >= input.length) return null;
  if (input[index] !== '"' && input[index] !== "'") {
    return { text: input.slice(index).trim(), end: input.length };
  }
  return readShellToken(input, index);
}

/**
 * Read one POSIX shell word and apply the quoting rules needed by Codex's
 * `/bin/zsh -lc '<script>'` wrapper. Shell words may concatenate quoted and
 * unquoted fragments, so this also handles the common `'can'\''t'` form.
 */
function readPosixShellToken(input: string, start: number): PosixShellToken | null {
  let index = start;
  while (index < input.length && /\s/.test(input[index])) index += 1;
  if (index >= input.length) return null;

  let text = '';
  let quoted = false;
  let hasUnquotedLiteral = false;
  while (index < input.length && !/\s/.test(input[index])) {
    const ch = input[index];
    if (ch === "'") {
      quoted = true;
      index += 1;
      while (index < input.length && input[index] !== "'") {
        text += input[index];
        index += 1;
      }
      if (index >= input.length) return null;
      index += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      index += 1;
      while (index < input.length && input[index] !== '"') {
        if (input[index] === '\\') {
          const next = input[index + 1];
          if (next === undefined) return null;
          if (next === '$' || next === '`' || next === '"' || next === '\\' || next === '\n') {
            if (next === '\n') {
              index += 2;
              continue;
            }
            text += next;
            index += 2;
            continue;
          }
        }
        text += input[index];
        index += 1;
      }
      if (index >= input.length) return null;
      index += 1;
      continue;
    }
    if (ch === '\\') {
      const next = input[index + 1];
      if (next === undefined) return null;
      if (next !== '\n') text += next;
      index += 2;
      continue;
    }
    hasUnquotedLiteral = true;
    text += ch;
    index += 1;
  }
  return { text, end: index, quoted, hasUnquotedLiteral };
}

function isWindowsPowerShellWrapperExecutable(binary: string): boolean {
  // Codex's Windows launcher is an absolute .exe path. A bare `pwsh` can be
  // an explicit user command, so preserve it verbatim instead of guessing.
  if (!/(?:^|[\\/])(?:pwsh|powershell)\.exe$/i.test(binary)) return false;
  return /^[A-Za-z]:[\\/]/.test(binary) || /^[\\/]{2}/.test(binary);
}

function isWindowsCmdWrapperExecutable(binary: string): boolean {
  if (!/(?:^|[\\/])cmd(?:\.exe)?$/i.test(binary)) return false;
  if (!binary.includes('\\') && !binary.includes('/')) return true;
  return /^[A-Za-z]:[\\/]/.test(binary) || /^[\\/]{2}/.test(binary);
}

function isPosixShellWrapperExecutable(binary: string): boolean {
  return /^(?:(?:\/bin|\/usr\/bin|\/usr\/local\/bin)\/)?(?:zsh|bash|sh)$/.test(binary);
}

function isPosixEnvExecutable(binary: string): boolean {
  return /^(?:(?:\/bin|\/usr\/bin)\/)?env$/.test(binary);
}

/** A bare script is accepted only when the complete argument is one ordinary shell word. */
function isUnambiguousBareScript(script: PosixShellToken): boolean {
  return !script.quoted && /^[A-Za-z0-9_./:@%+=,-]+$/.test(script.text);
}

function displayCommandFromPosixShellWrapper(command: string): string | null {
  let executable = readPosixShellToken(command, 0);
  if (!executable) return null;
  if (isPosixEnvExecutable(executable.text)) {
    executable = readPosixShellToken(command, executable.end);
    if (!executable) return null;
  }
  if (!isPosixShellWrapperExecutable(executable.text)) return null;

  const option = readPosixShellToken(command, executable.end);
  if (!option || (option.text !== '-lc' && option.text !== '-c')) return null;

  const script = readPosixShellToken(command, option.end);
  if (!script?.text || command.slice(script.end).trim()) return null;
  if (script.quoted) {
    if (script.hasUnquotedLiteral) return null;
  } else if (!isUnambiguousBareScript(script)) {
    return null;
  }
  return script.text;
}

function displayCommandFromPowerShellWrapper(command: string): string | null {
  const executable = readShellToken(command, 0);
  if (!executable || !isWindowsPowerShellWrapperExecutable(executable.text)) return null;

  let index = executable.end;
  while (true) {
    const token = readShellToken(command, index);
    if (!token) return null;
    if (/^-(?:command|c)$/i.test(token.text)) {
      const displayCommand = readCommandRemainder(command, token.end);
      if (!displayCommand || command.slice(displayCommand.end).trim()) return null;
      return displayCommand.text || null;
    }
    index = token.end;
  }
}

function displayCommandFromCmdWrapper(command: string): string | null {
  const executable = readShellToken(command, 0);
  if (!executable || !isWindowsCmdWrapperExecutable(executable.text)) return null;
  const option = readShellToken(command, executable.end);
  if (!option || !/^\/c$/i.test(option.text)) return null;
  const displayCommand = readCommandRemainder(command, option.end);
  if (!displayCommand || command.slice(displayCommand.end).trim()) return null;
  return displayCommand.text || null;
}

/**
 * Return the command inside a known shell launcher, or null when the input is
 * not a recognized, unambiguous wrapper. This is presentation-only: callers
 * still retain the raw command for execution and audit purposes.
 */
export function normalizeDisplayCommand(command: string): string | null {
  if (typeof command !== 'string' || !command.trim()) return null;
  return displayCommandFromPosixShellWrapper(command)
    ?? displayCommandFromPowerShellWrapper(command)
    ?? displayCommandFromCmdWrapper(command);
}
