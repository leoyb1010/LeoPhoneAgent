import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMobileMakerTransport, type RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { PendingInteraction, RemoteMessage, RemoteSession } from '@/session/types';

function session(id: string): RemoteSession {
  return {
    id,
    userId: 'user-1',
    title: 'Smoke session',
    workingDir: '/repo',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'ask',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function message(id: string, role: RemoteMessage['role'], content: unknown, createdAt: string): RemoteMessage {
  return {
    id,
    clientId: id,
    sessionId: 's1',
    role,
    content,
    toolUseId: null,
    agentMeta: null,
    createdAt,
  };
}

describe('mobile remote-control headless smoke', () => {
  beforeEach(() => remoteSessionStore.clear());

  it('mirrors a desktop session, sends a turn, receives pushes, and resolves an interaction', async () => {
    const calls: Array<{ channel: string; args?: unknown[] }> = [];
    const pending: PendingInteraction = {
      request: { kind: 'permission', requestId: 'perm-1', toolName: 'Bash', input: { command: 'ls' } },
    };
    const invokeMock = vi.fn(async (_deviceId: string, channel: string, args?: unknown[]) => {
      calls.push({ channel, args });
      if (channel === 'local-db:messages:list') {
        return [message('m1', 'user', { text: 'hello from phone' }, '2026-01-01T00:00:01.000Z')];
      }
      if (channel === 'maker:get-pending-interactions') return [];
      if (channel === 'maker:send') return { accepted: true };
      if (channel === 'maker:resolve-interaction') return { ok: true };
      throw new Error(`unexpected channel ${channel}`);
    });
    const invoke: RemoteInvoke = (deviceId, channel, args) =>
      invokeMock(deviceId, channel, args) as Promise<never>;
    const maker = createMobileMakerTransport({ deviceId: 'dev-1', invoke });

    remoteSessionStore.setDeviceSessions('dev-1', 'MacBook', [session('s1')]);
    expect(remoteSessionStore.getSessions()[0]).toMatchObject({
      id: 's1',
      deviceLinkDeviceId: 'dev-1',
      deviceLinkDeviceName: 'MacBook',
    });

    const history = await maker.listMessages('s1', { limit: 80 });
    remoteSessionStore.mergeMessages('s1', history);
    expect(normalizeRemoteMessages(remoteSessionStore.getMessages('s1')).map((item) => item.body)).toEqual([
      'hello from phone',
    ]);

    await maker.send('s1', 'continue', undefined, { throwOnStartFailure: true });
    expect(calls.find((call) => call.channel === 'maker:send')).toMatchObject({
      args: ['s1', 'continue', undefined, { throwOnStartFailure: true }],
    });

    remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
      sessionId: 's1',
      message: message('m2', 'assistant', 'desktop answer', '2026-01-01T00:00:02.000Z'),
    });
    expect(normalizeRemoteMessages(remoteSessionStore.getMessages('s1')).map((item) => item.body)).toEqual([
      'hello from phone',
      'desktop answer',
    ]);

    remoteSessionStore.applyRemotePush('dev-1', 'maker:interaction-request', {
      sessionId: 's1',
      request: pending.request,
    });
    expect(remoteSessionStore.getPendingInteractions('s1')).toEqual([pending]);

    await maker.resolveInteraction('perm-1', { kind: 'permission', behavior: 'allow' });
    remoteSessionStore.applyRemotePush('dev-1', 'maker:interaction-dismissed', {
      sessionId: 's1',
      requestId: 'perm-1',
    });
    expect(remoteSessionStore.getPendingInteractions('s1')).toEqual([]);
  });
});
