import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveWorkspaceSurface } from './workspaceSurface';

test('the library opens without a project, including while projects are loading', () => {
  for (const isMobile of [false, true]) {
    for (const isLoading of [false, true]) {
      assert.equal(resolveWorkspaceSurface('collections', { hasProject: false, isMobile, isLoading }), 'collections');
    }
  }
});

test('global routing preserves the single new-task entry and project-scoped workspace', () => {
  assert.equal(resolveWorkspaceSurface('dashboard', { hasProject: true, isMobile: false, isLoading: false }), 'new-task');
  assert.equal(resolveWorkspaceSurface('chat', { hasProject: true, isMobile: false, isLoading: false }), 'project');
  assert.equal(resolveWorkspaceSurface('chat', { hasProject: false, isMobile: false, isLoading: false }), 'new-task');
  assert.equal(resolveWorkspaceSurface('chat', { hasProject: false, isMobile: true, isLoading: false }), 'empty');
  assert.equal(resolveWorkspaceSurface('fleet', { hasProject: false, isMobile: false, isLoading: false }), 'fleet');
});
