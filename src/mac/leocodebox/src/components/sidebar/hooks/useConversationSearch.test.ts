import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseConversationProgressEvent,
  parseConversationResultEvent,
} from './useConversationSearch';

test('parses valid streamed conversation result events', () => {
  const parsed = parseConversationResultEvent(JSON.stringify({
    projectResult: {
      projectId: 'project-1',
      projectName: 'project-1',
      projectDisplayName: 'Project 1',
      sessions: [],
    },
    totalMatches: 2,
    scannedProjects: 1,
    totalProjects: 3,
  }));

  assert.equal(parsed?.projectResult.projectId, 'project-1');
  assert.equal(parsed?.totalMatches, 2);
});

test('rejects malformed or incomplete streamed search events', () => {
  assert.equal(parseConversationResultEvent('{bad json'), null);
  assert.equal(parseConversationResultEvent(JSON.stringify({ projectResult: {}, totalMatches: 1 })), null);
  assert.equal(parseConversationProgressEvent(JSON.stringify({
    totalMatches: 1,
    scannedProjects: 2,
    totalProjects: 3,
  }))?.scannedProjects, 2);
  assert.equal(parseConversationProgressEvent(JSON.stringify({ totalMatches: '1' })), null);
});
