import assert from 'node:assert/strict';
import test from 'node:test';

import { incrementProjectProviderCount } from './projectProviderCounts';

test('increments only the matching provider count', () => {
  assert.deepEqual(
    incrementProjectProviderCount({ codex: 2, claude: 1 }, 'codex'),
    { codex: 3, claude: 1 },
  );
  assert.deepEqual(incrementProjectProviderCount(undefined, 'opencode'), { opencode: 1 });
});
