import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { Logger } from '../../../interfaces/logger.js';

const sdkMock = vi.hoisted(() => ({
  forkSession: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: sdkMock.forkSession,
  query: sdkMock.query,
}));

import { ClaudeCodeAgent } from '../index.js';

const tempDirs: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

function createNoopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createDeps(): AgentDeps {
  const auth: AuthAdapter = {
    async getState() {
      return { authenticated: true };
    },
    async triggerLogin() {
      return { authenticated: true };
    },
    async logout() {},
    async getAuthEnv() {
      return {};
    },
  };

  return {
    auth,
    runtimeConfig: {},
    binaryPath: process.execPath,
    logger: createNoopLogger(),
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-claude-fork-'));
  tempDirs.push(dir);
  return dir;
}

function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

function countInvalidPreservedSegmentRefs(entries: Array<Record<string, unknown>>): number {
  const uuids = new Set(entries.map((entry) => entry.uuid).filter((uuid): uuid is string => typeof uuid === 'string'));
  let invalid = 0;
  for (const entry of entries) {
    const compactMetadata = entry.compactMetadata as Record<string, unknown> | undefined;
    const segment = compactMetadata?.preservedSegment as Record<string, unknown> | undefined;
    if (!segment) continue;
    for (const key of ['headUuid', 'anchorUuid', 'tailUuid']) {
      const value = segment[key];
      if (typeof value === 'string' && !uuids.has(value)) invalid += 1;
    }
  }
  return invalid;
}

async function readJsonl(filePath: string): Promise<Array<Record<string, unknown>>> {
  const text = await fs.readFile(filePath, 'utf8');
  return text.trimEnd().split('\n').filter(Boolean).map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

afterEach(async () => {
  sdkMock.forkSession.mockReset();
  sdkMock.query.mockReset();
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('ClaudeCodeAgent.forkSdkSession', () => {
  it('clears dangling source compact metadata before SDK fork', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const projectsRoot = path.join(configDir, 'projects');
    const workingDir = path.join(configDir, 'repo');
    const projectDir = path.join(projectsRoot, workingDir.replace(/[^a-zA-Z0-9]/g, '-'));
    await fs.mkdir(projectDir, { recursive: true });

    const sourceSessionId = '99999999-9999-4999-8999-999999999999';
    const newSessionId = '88888888-8888-4888-8888-888888888888';
    const sourcePath = path.join(projectDir, `${sourceSessionId}.jsonl`);
    const newPath = path.join(projectDir, `${newSessionId}.jsonl`);
    await fs.writeFile(
      sourcePath,
      [
        line({ type: 'user', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sessionId: sourceSessionId }),
        line({
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          sessionId: sourceSessionId,
          compactMetadata: {
            preservedSegment: {
              headUuid: '11111111-1111-4111-8111-111111111111',
              anchorUuid: '22222222-2222-4222-8222-222222222222',
              tailUuid: '33333333-3333-4333-8333-333333333333',
            },
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    let sourceAtSdkFork: Array<Record<string, unknown>> = [];
    sdkMock.forkSession.mockImplementation(async () => {
      sourceAtSdkFork = await readJsonl(sourcePath);
      await fs.writeFile(
        newPath,
        line({ type: 'user', uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', sessionId: newSessionId }) + '\n',
        'utf8',
      );
      return { sessionId: newSessionId };
    });

    const result = await new ClaudeCodeAgent(createDeps()).forkSdkSession({
      sourceSdkSessionId: sourceSessionId,
      upToMessageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: '[Fork] source',
      workingDir,
    });

    const compact = sourceAtSdkFork.at(-1) as { compactMetadata: Record<string, unknown> };
    expect(sdkMock.forkSession).toHaveBeenCalledOnce();
    expect(result.newSdkSessionId).toBe(newSessionId);
    expect(countInvalidPreservedSegmentRefs(sourceAtSdkFork)).toBe(0);
    expect(compact.compactMetadata.preservedSegment).toBeUndefined();
    expect(compact.compactMetadata.preservedMessages).toBeUndefined();
    const backups = (await fs.readdir(projectDir)).filter((name) => name.startsWith(`${sourceSessionId}.jsonl.bak.`));
    expect(backups).toHaveLength(1);
  });

  it('repairs stale source compact references before asking the Claude SDK to fork', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const projectsRoot = path.join(configDir, 'projects');
    const workingDir = path.join(configDir, 'repo');
    const projectDir = path.join(projectsRoot, workingDir.replace(/[^a-zA-Z0-9]/g, '-'));
    await fs.mkdir(projectDir, { recursive: true });

    const sourceSessionId = '99999999-9999-4999-8999-999999999999';
    const newSessionId = '88888888-8888-4888-8888-888888888888';
    const headParent = '11111111-1111-4111-8111-111111111111';
    const anchorParent = '22222222-2222-4222-8222-222222222222';
    const tailParent = '33333333-3333-4333-8333-333333333333';
    const headSource = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const anchorSource = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const tailSource = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const boundarySource = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const headNew = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const anchorNew = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const tailNew = 'abababab-abab-4bab-8bab-abababababab';
    const boundaryNew = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    const sourcePath = path.join(projectDir, `${sourceSessionId}.jsonl`);
    const newPath = path.join(projectDir, `${newSessionId}.jsonl`);

    await fs.writeFile(
      sourcePath,
      [
        line({ type: 'user', uuid: headSource, sessionId: sourceSessionId, forkedFrom: { sessionId: 'parent', messageUuid: headParent } }),
        line({ type: 'user', uuid: anchorSource, sessionId: sourceSessionId, forkedFrom: { sessionId: 'parent', messageUuid: anchorParent } }),
        line({ type: 'assistant', uuid: tailSource, sessionId: sourceSessionId, forkedFrom: { sessionId: 'parent', messageUuid: tailParent } }),
        line({
          type: 'system',
          subtype: 'compact_boundary',
          uuid: boundarySource,
          sessionId: sourceSessionId,
          compactMetadata: {
            preservedSegment: {
              headUuid: headParent,
              anchorUuid: anchorParent,
              tailUuid: tailParent,
            },
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    let invalidRefsAtSdkFork = -1;
    sdkMock.forkSession.mockImplementation(async () => {
      const repairedSource = await readJsonl(sourcePath);
      invalidRefsAtSdkFork = countInvalidPreservedSegmentRefs(repairedSource);
      const compact = repairedSource.at(-1) as Record<string, unknown>;
      await fs.writeFile(
        newPath,
        [
          line({ type: 'user', uuid: headNew, sessionId: newSessionId, forkedFrom: { sessionId: sourceSessionId, messageUuid: headSource } }),
          line({ type: 'user', uuid: anchorNew, sessionId: newSessionId, forkedFrom: { sessionId: sourceSessionId, messageUuid: anchorSource } }),
          line({ type: 'assistant', uuid: tailNew, sessionId: newSessionId, forkedFrom: { sessionId: sourceSessionId, messageUuid: tailSource } }),
          line({
            ...compact,
            uuid: boundaryNew,
            sessionId: newSessionId,
            forkedFrom: { sessionId: sourceSessionId, messageUuid: boundarySource },
          }),
        ].join('\n') + '\n',
        'utf8',
      );
      return { sessionId: newSessionId };
    });

    const result = await new ClaudeCodeAgent(createDeps()).forkSdkSession({
      sourceSdkSessionId: sourceSessionId,
      upToMessageId: tailSource,
      title: '[Fork] source',
      workingDir,
    });

    expect(invalidRefsAtSdkFork).toBe(0);
    expect(sdkMock.forkSession).toHaveBeenCalledWith(sourceSessionId, {
      upToMessageId: tailSource,
      title: '[Fork] source',
    });
    expect(result.newSdkSessionId).toBe(newSessionId);
    expect(result.uuidMap).toEqual(new Map([
      [headSource, headNew],
      [anchorSource, anchorNew],
      [tailSource, tailNew],
      [boundarySource, boundaryNew],
    ]));
    const repairedNew = await readJsonl(newPath);
    expect(countInvalidPreservedSegmentRefs(repairedNew)).toBe(0);
  });

  it('repairs source JSONL and retries once when SDK fork reports invalid compact preservedSegment refs', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const projectsRoot = path.join(configDir, 'projects');
    const workingDir = path.join(configDir, 'repo');
    const projectDir = path.join(projectsRoot, workingDir.replace(/[^a-zA-Z0-9]/g, '-'));
    await fs.mkdir(projectDir, { recursive: true });

    const sourceSessionId = '99999999-9999-4999-8999-999999999999';
    const newSessionId = '88888888-8888-4888-8888-888888888888';
    const sourcePath = path.join(projectDir, `${sourceSessionId}.jsonl`);
    const newPath = path.join(projectDir, `${newSessionId}.jsonl`);
    await fs.writeFile(
      sourcePath,
      [
        line({ type: 'user', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sessionId: sourceSessionId }),
        line({
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          sessionId: sourceSessionId,
          compactMetadata: {
            postTokens: 10,
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    let retryInvalidRefsAtSdkFork = -1;
    sdkMock.forkSession
      .mockImplementationOnce(async () => {
        await fs.writeFile(
          sourcePath,
          [
            line({ type: 'user', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sessionId: sourceSessionId }),
            line({
              type: 'system',
              subtype: 'compact_boundary',
              uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              sessionId: sourceSessionId,
              compactMetadata: {
                postTokens: 10,
                preservedSegment: {
                  headUuid: '11111111-1111-4111-8111-111111111111',
                },
                preservedMessages: {
                  uuids: ['11111111-1111-4111-8111-111111111111'],
                },
              },
            }),
          ].join('\n') + '\n',
          'utf8',
        );
        throw new Error('source Claude JSONL has 1 invalid compact preservedSegment reference(s) before fork');
      })
      .mockImplementationOnce(async () => {
        const repairedSource = await readJsonl(sourcePath);
        retryInvalidRefsAtSdkFork = countInvalidPreservedSegmentRefs(repairedSource);
        await fs.writeFile(
          newPath,
          line({ type: 'user', uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', sessionId: newSessionId }) + '\n',
          'utf8',
        );
        return { sessionId: newSessionId };
      });

    const result = await new ClaudeCodeAgent(createDeps()).forkSdkSession({
      sourceSdkSessionId: sourceSessionId,
      upToMessageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: '[Fork] source',
      workingDir,
    });

    expect(sdkMock.forkSession).toHaveBeenCalledTimes(2);
    expect(retryInvalidRefsAtSdkFork).toBe(0);
    expect(result.newSdkSessionId).toBe(newSessionId);
    const repairedSource = await readJsonl(sourcePath);
    const compact = repairedSource.at(-1) as { compactMetadata: Record<string, unknown> };
    expect(compact.compactMetadata).toEqual({ postTokens: 10 });
    const backups = (await fs.readdir(projectDir)).filter((name) => name.startsWith(`${sourceSessionId}.jsonl.bak.`));
    expect(backups).toHaveLength(1);
  });
});
