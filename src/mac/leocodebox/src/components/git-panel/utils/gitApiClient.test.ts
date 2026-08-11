import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGitUrl } from './gitApiClient';

test('buildGitUrl encodes project ids, paths, and optional values', () => {
  assert.equal(
    buildGitUrl('diff', {
      project: 'project id',
      file: 'src/a file.ts',
      ignored: null,
    }),
    '/api/git/diff?project=project+id&file=src%2Fa+file.ts',
  );
});

test('buildGitUrl omits the query separator for empty parameters', () => {
  assert.equal(buildGitUrl('fetch'), '/api/git/fetch');
});
