import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyProviderError,
  isMissingCliExecutableError,
  isStandaloneProviderAuthenticationFailure,
} from '../provider-errors.js';

test('detects a missing Claude executable without hiding unrelated SDK failures', () => {
  const missing = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT', path: 'claude' });
  assert.equal(isMissingCliExecutableError(missing, 'claude'), true);
  assert.equal(isMissingCliExecutableError(new Error('401 authentication failed'), 'claude'), false);
  assert.equal(isMissingCliExecutableError(new Error('Model claude-x was not found'), 'claude'), false);
  assert.equal(isMissingCliExecutableError(new Error('Project directory is not accessible'), 'claude'), false);
});

test('classifies provider authentication failures without rewriting unrelated errors', () => {
  assert.equal(classifyProviderError('Not logged in · Please run /login')?.code, 'PROVIDER_NOT_AUTHENTICATED');
  assert.equal(classifyProviderError('Claude login has expired')?.code, 'PROVIDER_AUTH_EXPIRED');
  assert.equal(classifyProviderError('credentials are present but unusable')?.code, 'PROVIDER_AUTH_INVALID');
    assert.equal(classifyProviderError('spawn opencode ENOENT')?.code, 'PROVIDER_CLI_NOT_FOUND');
    assert.equal(classifyProviderError('/bin/sh: terraform: command not found'), null);
  assert.equal(classifyProviderError('Model claude-x was not found'), null);
  assert.equal(isStandaloneProviderAuthenticationFailure('Not logged in · Please run /login'), true);
  assert.equal(isStandaloneProviderAuthenticationFailure('The documentation says users are not logged in by default.'), false);
});
