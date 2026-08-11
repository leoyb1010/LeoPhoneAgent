import assert from 'node:assert/strict';
import test from 'node:test';

import React, { useRef } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import type { Project, ProjectSession } from '../../../types/app';
import { useSessionStore, type SessionStore } from '../../../stores/useSessionStore';

import { useChatSessionState } from './useChatSessionState';

const project = {
  projectId: 'project-1',
  path: '/tmp/project-1',
  fullPath: '/tmp/project-1',
  displayName: 'project-1',
} as Project;
const selectedSession = {
  id: 'new-session',
  summary: 'new session',
  __provider: 'claude',
  __projectId: 'project-1',
} as ProjectSession;
const sendMessage = () => {};

test('active new session renders the first realtime message without reselecting it', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  // Keep the initial history request in flight, matching the provider window
  // before its transcript exists. The realtime row must still render at once.
  globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });

  let sessionStore: SessionStore | null = null;

  function Harness() {
    const store = useSessionStore();
    const statusCheckSentAtRef = useRef(new Map<string, number>());
    const lastSeqRef = useRef(new Map<string, number>());
    const state = useChatSessionState({
      selectedProject: project,
      selectedSession,
      ws: null,
      sendMessage,
      statusCheckSentAtRef,
      lastSeqRef,
      sessionStore: store,
    });
    sessionStore = store;
    return <output>{state.chatMessages.length}</output>;
  }

  let renderer: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(<Harness />);
    });
    assert.equal(renderer!.root.findByType('output').children.join(''), '0');

    act(() => {
      sessionStore!.appendRealtime('new-session', {
        id: 'first-user-message',
        sessionId: 'new-session',
        timestamp: new Date().toISOString(),
        provider: 'claude',
        kind: 'text',
        role: 'user',
        content: 'hello',
      });
    });

    assert.equal(renderer!.root.findByType('output').children.join(''), '1');
  } finally {
    await act(async () => renderer?.unmount());
    globalThis.fetch = originalFetch;
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
});
