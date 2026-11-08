export interface LinuxPoll {
  buffer: ArrayBuffer;
  stderrBuffer: ArrayBuffer;
  stderrTruncated: boolean;
  exited: boolean;
  exitCode: number;
  truncated: boolean;
}
export const initialize: (root: string, pack: string, workspace: string) => Promise<void>;
export const start: (command: string, interactive: boolean) => number;
export const poll: (pid: number) => LinuxPoll;
export const write: (pid: number, text: string) => number;
export const resize: (pid: number, columns: number, rows: number) => number;
export const stop: (pid: number) => number;
export const packHash: () => string;
export const preparePackages: (directory: string, pack: string) => Promise<void>;
export const packagesHash: () => string;

export const startStdio: (command: string) => number;

/** Exclusive basename creation under an already pinned trusted directory. Caller owns returned fd. */
export const createWorkspaceFile: (parentFd: number, basename: string) => number;
