import fs, { promises as fsPromises } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { browserUseService } from '@/modules/browser-use/browser-use.service.js';
import { initializeDatabase } from '@/modules/database/index.js';
import { closeSessionsWatcher, initializeSessionsWatcher } from '@/modules/providers/index.js';

import { IS_LOCAL_ONLY_AUTH } from '../middleware/auth.js';
import { configureWebPush } from '../services/vapid-keys.js';
import { c } from '../utils/colors.js';
import { startEnabledPluginServers, stopAllPlugins } from '../utils/plugin-process-manager.js';
import { getConnectableHost } from '../shared/network-hosts.js';

const SERVER_PORT = Number.parseInt(process.env.SERVER_PORT || '', 10) || 3001;
const HOST = process.env.HOST || (IS_LOCAL_ONLY_AUTH ? '127.0.0.1' : '0.0.0.0');
const DISPLAY_HOST = getConnectableHost(HOST);
const VITE_PORT = Number.parseInt(process.env.VITE_PORT || '', 10) || 5173;
const LOCAL_SERVER_MARKER_PATH = path.join(os.homedir(), '.leocodebox', 'local-server.json');

type ServerLifecycleOptions = {
  server: HttpServer;
  appRoot: string;
  installMode: string;
  runningVersion: string;
};

type LocalServerMarker = {
  pid?: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeLocalServerMarker({ appRoot, installMode, runningVersion }: Omit<ServerLifecycleOptions, 'server'>): Promise<void> {
  const localAuthToken = process.env.LEOCODEBOX_LOCAL_AUTH_TOKEN || process.env.CLOUDCLI_DESKTOP_LOCAL_AUTH_TOKEN || '';
  const marker = {
    pid: process.pid,
    port: SERVER_PORT,
    host: HOST,
    version: runningVersion,
    url: `http://${HOST}:${SERVER_PORT}`,
    installMode,
    appRoot,
    updatedAt: new Date().toISOString(),
    // The desktop shell reads this token back when it adopts an already-running
    // server (warm resume), so the file must stay user-only readable.
    ...(IS_LOCAL_ONLY_AUTH && localAuthToken ? { token: localAuthToken } : {}),
  };
  await fsPromises.mkdir(path.dirname(LOCAL_SERVER_MARKER_PATH), { recursive: true, mode: 0o700 });
  await fsPromises.writeFile(LOCAL_SERVER_MARKER_PATH, JSON.stringify(marker, null, 2), { encoding: 'utf8', mode: 0o600 });
}

async function removeLocalServerMarker(): Promise<void> {
  try {
    const marker = JSON.parse(await fsPromises.readFile(LOCAL_SERVER_MARKER_PATH, 'utf8')) as LocalServerMarker;
    if (marker.pid && marker.pid !== process.pid) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
  }
  try {
    await fsPromises.unlink(LOCAL_SERVER_MARKER_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[WARN] Could not remove local server marker:', errorMessage(error));
    }
  }
}

export async function startServerLifecycle({ server, appRoot, installMode, runningVersion }: ServerLifecycleOptions): Promise<void> {
  try {
    await initializeDatabase();
    if (!IS_LOCAL_ONLY_AUTH) configureWebPush();

    const isProduction = fs.existsSync(path.join(appRoot, 'dist', 'index.html'));
    console.log(`${c.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
    console.log('');
    if (isProduction) console.log(`${c.info('[INFO]')} To run in production mode, go to http://${DISPLAY_HOST}:${SERVER_PORT}`);
    console.log(`${c.info('[INFO]')} To run in development mode with hot-module replacement, go to http://${DISPLAY_HOST}:${VITE_PORT}`);

    server.listen(SERVER_PORT, HOST, async () => {
      await writeLocalServerMarker({ appRoot, installMode, runningVersion }).catch((error) => {
        console.warn('[WARN] Could not write local server marker:', errorMessage(error));
      });
      console.log('');
      console.log(c.dim('═'.repeat(63)));
      console.log(`  ${c.bright('leocodebox Server - Ready')}`);
      console.log(c.dim('═'.repeat(63)));
      console.log('');
      console.log(`${c.info('[INFO]')} Server URL:  ${c.bright(`http://${DISPLAY_HOST}:${SERVER_PORT}`)}`);
      console.log(`${c.info('[INFO]')} Installed at: ${c.dim(appRoot)}`);
      console.log(`${c.tip('[TIP]')}  Run "leocodebox status" for full configuration details`);
      console.log('');
      await initializeSessionsWatcher();
      startEnabledPluginServers().catch((error) => console.error('[Plugins] Error during startup:', errorMessage(error)));
    });

    const shutdownRuntimeServices = async () => {
      try { await closeSessionsWatcher(); } catch (error) { console.error('[Sessions] Error closing sessions watcher during shutdown:', errorMessage(error)); }
      try { await browserUseService.stopAllSessions(); } catch (error) { console.error('[Browser] Error stopping sessions during shutdown:', errorMessage(error)); }
      try { await stopAllPlugins(); } catch (error) { console.error('[Plugins] Error stopping plugins during shutdown:', errorMessage(error)); }
      try { await removeLocalServerMarker(); } catch (error) { console.error('[Local Server] Error removing server marker during shutdown:', errorMessage(error)); }
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdownRuntimeServices());
    process.on('SIGINT', () => void shutdownRuntimeServices());

    const desktopParentPid = Number.parseInt(process.env.LEOCODEBOX_DESKTOP_PARENT_PID || '', 10);
    if (IS_LOCAL_ONLY_AUTH && Number.isInteger(desktopParentPid) && desktopParentPid > 1 && desktopParentPid !== process.pid) {
      const parentWatchdog = setInterval(() => {
        try {
          process.kill(desktopParentPid, 0);
        } catch {
          clearInterval(parentWatchdog);
          console.warn('[Local Server] Desktop parent exited unexpectedly; stopping local services.');
          void shutdownRuntimeServices();
        }
      }, 1000);
      parentWatchdog.unref();
    }
  } catch (error) {
    console.error('[ERROR] Failed to start server:', error);
    process.exit(1);
  }
}
