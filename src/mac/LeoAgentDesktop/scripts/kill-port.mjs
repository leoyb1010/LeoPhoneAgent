#!/usr/bin/env node

// 本地 E2E 清理服务端端口；默认 3333，也可通过 PORT 覆盖。
import { execFileSync, execSync } from 'node:child_process';

const port = Number(process.env.PORT) || 3333;
const isWindows = process.platform === 'win32';

function getPidsWindows(targetPort) {
  let output = '';
  try {
    output = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
  } catch {
    return [];
  }
  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (match && Number(match[1]) === targetPort && match[2] !== '0') pids.add(match[2]);
  }
  return [...pids];
}

function getPidsUnix(targetPort) {
  try {
    return execFileSync('lsof', ['-ti', `tcp:${targetPort}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    }).split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

const pids = isWindows ? getPidsWindows(port) : getPidsUnix(port);
if (pids.length === 0) {
  console.log(`[kill-port] port ${port} is free`);
  process.exit(0);
}

for (const pid of pids) {
  try {
    if (isWindows) {
      execFileSync('taskkill', ['/F', '/PID', pid], { stdio: 'ignore' });
    } else {
      execFileSync('kill', ['-9', pid], { stdio: 'ignore' });
    }
    console.log(`[kill-port] killed pid ${pid} on port ${port}`);
  } catch (error) {
    console.warn(`[kill-port] failed to kill pid ${pid}: ${error.message}`);
  }
}
