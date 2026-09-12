import assert from 'node:assert/strict';
import test from 'node:test';

import React, { useRef, useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import type { ChatCursor } from '../../../../shared/chat-session-protocol';
import type { ServerEvent } from '../../../contexts/WebSocketContext';
import type { ProjectSession } from '../../../types/app';
import type { SessionStore } from '../../../stores/useSessionStore';
import type { PendingPermissionRequest } from '../types/types';
import type { StreamBufferEntry } from '../utils/streamBuffers';

import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';

const approval: PendingPermissionRequest = {
  requestId: 'approval-1', sessionId: 'session-a', toolName: 'Bash', input: {}, receivedAt: new Date(),
};

test('only an authoritative approval resolution removes the pending request', async () => {
  let listener: (event: ServerEvent) => void = () => {};
  let requests: PendingPermissionRequest[] = [];
  const subscribe = (next: typeof listener) => { listener = next; return () => {}; };
  const store = { refreshFromServer: async () => {} } as unknown as SessionStore;
  function Harness() {
    const [pending, setPending] = useState([approval]);
    requests = pending;
    useChatRealtimeHandlers({ subscribe, provider: 'claude', selectedSession: { id: 'session-a' } as ProjectSession,
      currentSessionId: 'session-a', setTokenBudget: () => {}, pendingPermissionRequests: pending,
      setPendingPermissionRequests: setPending, streamBuffersRef: useRef(new Map<string, StreamBufferEntry>()),
      lastSeqRef: useRef(new Map<string, number>()), runCursorsRef: useRef(new Map<string, ChatCursor>()),
      statusCheckSentAtRef: useRef(new Map<string, number>()), sessionStore: store });
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => { renderer = TestRenderer.create(<Harness />); });
    act(() => listener({ kind: 'chat_permission_ack', sessionId: 'session-a', requestId: 'approval-1', status: 'delivery_failed' }));
    assert.equal(requests.length, 1);
    act(() => listener({ kind: 'permission_resolved', sessionId: 'session-b', requestId: 'other' }));
    assert.equal(requests.length, 1);
    act(() => listener({ kind: 'permission_resolved', sessionId: 'session-a', requestId: 'approval-1' }));
    assert.equal(requests.length, 0);
  } finally { await act(async () => renderer.unmount()); }
});
