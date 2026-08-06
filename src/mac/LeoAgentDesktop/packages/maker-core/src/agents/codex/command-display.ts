interface ShellToken {
  text: string;
  end: number;
}

export interface CommandExecutionDisplayInput extends Record<string, unknown> {
  command: string;
  cwd?: string;
  displayCommand?: string;
  /** codex commandActions 原样透传（见 translator CommandExecutionItem 注释）。 */
  commandActions?: unknown[];
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

function readPowerShellCommandArgument(input: string, start: number): ShellToken | null {
  let index = start;
  while (index < input.length && /\s/.test(input[index])) index += 1;
  if (index >= input.length) return { text: '', end: input.length };
  const token = readShellToken(input, index);
  if (input[index] === '"' || input[index] === "'") return token;
  return { text: input.slice(index).trim(), end: input.length };
}

function isWindowsPowerShellWrapperExecutable(binary: string): boolean {
  if (!/(?:^|[\\/])(?:pwsh|powershell)\.exe$/i.test(binary)) return false;
  return /^[A-Za-z]:[\\/]/.test(binary) || /^[\\/]{2}/.test(binary) || /[\\/]WindowsApps[\\/]/i.test(binary);
}

export function displayCommandForCommandExecution(command: string): string {
  const executable = readShellToken(command, 0);
  if (!executable || !isWindowsPowerShellWrapperExecutable(executable.text)) return command;

  let index = executable.end;
  while (true) {
    const token = readShellToken(command, index);
    if (!token) return command;
    if (/^-(?:command|c)$/i.test(token.text)) {
      const displayCommand = readPowerShellCommandArgument(command, token.end);
      if (!displayCommand) return command;
      if (command.slice(displayCommand.end).trim()) return command;
      return displayCommand.text || command;
    }
    index = token.end;
  }
}

export function commandExecutionDisplayInput(command: string, cwd?: string): CommandExecutionDisplayInput {
  const displayCommand = displayCommandForCommandExecution(command);
  const input: CommandExecutionDisplayInput = { command };
  if (cwd !== undefined) input.cwd = cwd;
  if (displayCommand !== command) input.displayCommand = displayCommand;
  return input;
}
