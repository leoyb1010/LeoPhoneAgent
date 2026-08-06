import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir = '';

const scriptPath = path.resolve(process.cwd(), 'scripts/assert-codex-proxy-e2e.mjs');

function injectionMsg(fields: Record<string, string | number | boolean>): string {
  return [
    'codex proxy instructions injection',
    ...Object.entries(fields).map(([key, value]) => `  ${key.padEnd(24)} : ${String(value)}`),
    '────────────────────────────────────────────────────────────────────────',
  ].join('\n');
}

function writeAgentLog(records: Array<Record<string, unknown>>): void {
  const file = path.join(tempDir, 'agent-2026-06-06.ndjson');
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
}

function runScript(args: string[]): string {
  return execFileSync(process.execPath, [scriptPath, '--log-dir', tempDir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('assert-codex-proxy-e2e script', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-e2e-'));
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('passes for registry-hit thread-id events even when codex adds its own developer input', () => {
    writeAgentLog([
      {
        ts: 1,
        seq: 1,
        source: 'proxy',
        scope: 'codex-proxy',
        msg: injectionMsg({
          event: 'codex_proxy_injection',
          selectedHeaderName: 'thread-id',
          selectedThreadId: 'thread-1',
          registryHit: true,
          instructionsBeforeBytes: 100,
          instructionsAfterBytes: 200,
          inputDeveloperCount: 1,
          appended: true,
          alreadyPresent: false,
        }),
      },
    ]);

    expect(runScript(['--thread', 'thread-1'])).toContain('events=1, threads=1');
  });

  it('fails when a selected event is a registry miss', () => {
    writeAgentLog([
      {
        ts: 1,
        seq: 1,
        source: 'proxy',
        scope: 'codex-proxy',
        msg: injectionMsg({
          event: 'codex_proxy_injection',
          selectedHeaderName: 'thread-id',
          selectedThreadId: 'thread-1',
          registryHit: false,
          instructionsBeforeBytes: 100,
          instructionsAfterBytes: 100,
          inputDeveloperCount: 0,
          appended: false,
          alreadyPresent: false,
        }),
      },
    ]);

    expect(() => runScript(['--thread', 'thread-1'])).toThrow(/did not hit registry|Registry miss/);
  });

  it('checks sentinel uniqueness from transformed body dumps while allowing unrelated developer inputs', () => {
    const bodyDump = path.join(tempDir, 'bodies.ndjson');
    writeAgentLog([
      {
        ts: 1,
        seq: 1,
        source: 'proxy',
        scope: 'codex-proxy',
        msg: injectionMsg({
          event: 'codex_proxy_injection',
          selectedHeaderName: 'thread-id',
          selectedThreadId: 'thread-1',
          registryHit: true,
          instructionsBeforeBytes: 100,
          instructionsAfterBytes: 200,
          inputDeveloperCount: 1,
          appended: true,
          alreadyPresent: false,
        }),
      },
    ]);
    fs.writeFileSync(
      bodyDump,
      JSON.stringify({
        threadId: 'thread-1',
        body: {
          instructions: 'BASE\n\nSENTINEL',
          input: [
            { role: 'developer', content: 'codex permissions scaffolding' },
            { role: 'user', content: 'hi' },
          ],
        },
      }) + '\n',
      'utf8',
    );

    expect(runScript(['--thread', 'thread-1', '--sentinel', 'SENTINEL', '--body-dump', bodyDump]))
      .toContain('bodies=1');
  });

  it('fails when a developer input contains the session sentinel', () => {
    const bodyDump = path.join(tempDir, 'bodies.ndjson');
    writeAgentLog([
      {
        ts: 1,
        seq: 1,
        source: 'proxy',
        scope: 'codex-proxy',
        msg: injectionMsg({
          event: 'codex_proxy_injection',
          selectedHeaderName: 'thread-id',
          selectedThreadId: 'thread-1',
          registryHit: true,
          instructionsBeforeBytes: 100,
          instructionsAfterBytes: 200,
          inputDeveloperCount: 1,
          appended: true,
          alreadyPresent: false,
        }),
      },
    ]);
    fs.writeFileSync(
      bodyDump,
      JSON.stringify({
        threadId: 'thread-1',
        body: {
          instructions: 'BASE\n\nSENTINEL',
          input: [{ role: 'developer', content: 'leaked SENTINEL' }],
        },
      }) + '\n',
      'utf8',
    );

    expect(() => runScript(['--thread', 'thread-1', '--sentinel', 'SENTINEL', '--body-dump', bodyDump]))
      .toThrow(/Developer input message contains forbidden marker/);
  });

  it('checks per-thread sentinels from a transformed body dump directory', () => {
    const dumpDir = path.join(tempDir, 'codex-proxy-dumps');
    fs.mkdirSync(dumpDir, { recursive: true });
    writeAgentLog([
      {
        ts: 1,
        seq: 1,
        source: 'proxy',
        scope: 'codex-proxy',
        msg: injectionMsg({
          event: 'codex_proxy_injection',
          selectedHeaderName: 'thread-id',
          selectedThreadId: 'worker-thread',
          registryHit: true,
          instructionsBeforeBytes: 100,
          instructionsAfterBytes: 200,
          inputDeveloperCount: 1,
          appended: true,
          alreadyPresent: false,
        }),
      },
      {
        ts: 2,
        seq: 2,
        source: 'proxy',
        scope: 'codex-proxy',
        msg: injectionMsg({
          event: 'codex_proxy_injection',
          selectedHeaderName: 'thread-id',
          selectedThreadId: 'plain-thread',
          registryHit: true,
          instructionsBeforeBytes: 100,
          instructionsAfterBytes: 200,
          inputDeveloperCount: 1,
          appended: true,
          alreadyPresent: false,
        }),
      },
    ]);
    fs.writeFileSync(
      path.join(dumpDir, 'worker-thread-000001.json'),
      JSON.stringify({
        threadId: 'worker-thread',
        body: {
          instructions: 'BASE\n\nWORKER_SENTINEL\nsend_to_lead worker_id',
          input: [{ role: 'developer', content: 'codex scaffolding' }],
        },
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(dumpDir, 'plain-thread-000002.json'),
      JSON.stringify({
        threadId: 'plain-thread',
        body: {
          instructions: 'BASE\n\nPLAIN_SENTINEL',
          input: [{ role: 'developer', content: 'codex scaffolding' }],
        },
      }),
      'utf8',
    );

    expect(runScript([
      '--expect', 'worker-thread:WORKER_SENTINEL',
      '--expect', 'plain-thread:PLAIN_SENTINEL',
      '--plain-thread', 'plain-thread',
      '--body-dump', dumpDir,
    ])).toContain('events=2, threads=2, bodies=2');
  });

  it('fails when transformed body dumps still contain forbidden gateway fields', () => {
    const bodyDump = path.join(tempDir, 'bodies.ndjson');
    writeAgentLog([
      {
        ts: 1,
        seq: 1,
        source: 'proxy',
        scope: 'codex-proxy',
        msg: injectionMsg({
          event: 'codex_proxy_injection',
          selectedHeaderName: 'thread-id',
          selectedThreadId: 'thread-1',
          registryHit: true,
          instructionsBeforeBytes: 100,
          instructionsAfterBytes: 200,
          inputDeveloperCount: 1,
          appended: true,
          alreadyPresent: false,
        }),
      },
    ]);
    fs.writeFileSync(
      bodyDump,
      JSON.stringify({
        threadId: 'thread-1',
        body: {
          instructions: 'BASE\n\nSENTINEL',
          output_config: { type: 'json' },
          input: [{ role: 'developer', content: 'codex scaffolding' }],
        },
      }) + '\n',
      'utf8',
    );

    expect(() => runScript(['--thread', 'thread-1', '--sentinel', 'SENTINEL', '--body-dump', bodyDump]))
      .toThrow(/Forbidden body field "output_config"/);
  });
});
