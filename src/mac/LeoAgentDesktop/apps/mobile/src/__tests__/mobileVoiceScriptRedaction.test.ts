import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';

const startedServers: Server[] = [];

afterEach(async () => {
  await Promise.all(startedServers.splice(0).map((server) => closeServer(server)));
});

describe('mobile voice script redaction', () => {
  it('redacts synced voice keys from cloud preflight failure output', async () => {
    const secret = 'sk-script/redact secret';
    const server = createServer((_request, response) => {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          message: `upstream rejected Authorization Bearer ${secret}`,
        },
      }));
    });
    startedServers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port');

    const result = await runNodeScript('scripts/mobile-voice-cloud-preflight.mjs', ['--run', '--refine-only'], {
      XDT_MOBILE_VOICE_CREDENTIAL_JSON: JSON.stringify({
        temporary: true,
        credentialVersion: 1,
        issuedAt: '2026-06-20T00:00:00.000Z',
        proxyBaseUrl: `http://127.0.0.1:${address.port}`,
        proxyApiKey: secret,
        asr: {
          provider: 'litellm-gpt-realtime-whisper',
          model: 'gpt-realtime-whisper',
          auth: 'api-key',
          mode: 'realtime-websocket',
          endpointPath: '/openai/passthrough/v1/realtime?intent=transcription',
          protocolProfile: 'openai-transcription-manual',
        },
        refiner: {
          provider: 'litellm-gpt-5.4-mini',
          model: 'gpt-5.4-mini',
          auth: 'api-key',
          transport: 'litellm-chat-completions',
          endpointPath: '/v1/chat/completions',
        },
        settings: {
          language: 'zh-CN',
          refinementEnabled: true,
          playInteractionSound: false,
        },
      }),
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).not.toBe(0);
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain(secret);
    expect(output).not.toContain(encodeURIComponent(secret));
  });
});

function runNodeScript(
  script: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
