/**
 * Faithful port of upstream `ensurePortAvailable` (src/infra/ports.ts) — a
 * self-contained TCP listen probe. Upstream pulled logger/runtime/globals for
 * unrelated helpers; only this probe is needed by the browser core (chrome.ts).
 */
import net from 'node:net';

export class PortInUseError extends Error {
  constructor(public readonly port: number) {
    super(`Port ${port} is already in use`);
    this.name = 'PortInUseError';
  }
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err && typeof err === 'object' && 'code' in err);
}

function tryListenOnPort(opts: { port: number; host?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err) => {
      server.close();
      reject(err);
    });
    server.listen(opts, () => {
      server.close(() => resolve());
    });
  });
}

/** Reject with PortInUseError when the port is already bound. */
export async function ensurePortAvailable(port: number, host?: string): Promise<void> {
  try {
    await tryListenOnPort(host ? { port, host } : { port });
  } catch (err) {
    if (isErrno(err) && err.code === 'EADDRINUSE') {
      throw new PortInUseError(port);
    }
    throw err;
  }
}
