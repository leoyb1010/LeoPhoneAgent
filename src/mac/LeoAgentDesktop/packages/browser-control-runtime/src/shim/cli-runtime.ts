/**
 * Shim: openclaw/plugin-sdk/cli-runtime.
 *
 * Only `formatCliCommand` is reached on the dispatcher path — and only to build
 * an operator hint string inside an error message (the original suggested
 * "restart the OpenClaw gateway", which does not apply to our in-process
 * runtime). We pass the command through unchanged. The rest are CLI-builder
 * helpers used only by the dropped CLI surface; they are no-op/identity stubs.
 */
export function formatCliCommand(command: string): string {
  return command;
}

export function formatHelpExamples(examples: unknown): unknown {
  return examples;
}

export function inheritOptionFromParent(): void {
  // no-op: no commander CLI in the in-process runtime
}

export function note(text: string): string {
  return text;
}

export const theme = {
  bold: (s: string) => s,
  dim: (s: string) => s,
  cyan: (s: string) => s,
  green: (s: string) => s,
  red: (s: string) => s,
  yellow: (s: string) => s,
};

export function runCommandWithRuntime(): never {
  throw new Error('cli-runtime.runCommandWithRuntime is not available in the in-process runtime');
}
