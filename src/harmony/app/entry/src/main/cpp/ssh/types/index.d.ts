export interface SSHConnectOptions {
  owner: string;
  host: string;
  port: number;
  username: string;
  hostKey: string;
  privateKey: string;
  passphrase: string;
  password: string;
}
export interface SSHOutput {
  buffer: ArrayBuffer;
  state: string;
  error: string;
  fingerprint: string;
  exitCode: number;
  truncated: boolean;
}
export function start(options: SSHConnectOptions): number;
export function poll(id: number, owner: string): SSHOutput;
export function write(id: number, owner: string, text: string): number;
export function resize(id: number, owner: string, columns: number, rows: number): void;
export function stop(id: number, owner: string): void;
