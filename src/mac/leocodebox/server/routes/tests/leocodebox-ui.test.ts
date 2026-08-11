import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const pagePath = path.resolve('public/leocodebox-switch.html');

test('Leoapi provider cards expose health and user-confirmed failover controls', async () => {
  const html = await fs.readFile(pagePath, 'utf8');
  assert.match(html, /function providerHealth\(provider\)/);
  assert.match(html, /modelDiscoveryError/);
  assert.match(html, /latencyMs/);
  assert.match(html, /data-failover=/);
  assert.match(html, /await confirmDialog\(prompt\)/);
  assert.doesNotMatch(html, /window\.confirm\(/);
  assert.match(html, /切换前会自动备份现有配置/);
});

test('Leoapi provider list tells the three-card story with styled confirmation', async () => {
  const html = await fs.readFile(pagePath, 'utf8');
  assert.match(html, /本机原配置/);
  assert.match(html, /今天在用/);
  assert.match(html, /备选节点/);
  assert.match(html, /id="confirmDialog"/);
  assert.match(html, /data-endpoint-label/);
  assert.match(html, /endpointLabels/);
  assert.match(html, /endpoint-bar/);
  assert.match(html, /leocodebox-switch:close/);
});

test('Leoapi uses the same local provider identity set as the workbench', async () => {
  const html = await fs.readFile(pagePath, 'utf8');
  assert.match(html, /\/icons\/providers\/\$\{targetId\}\.svg/);
  assert.doesNotMatch(html, /claude: "activity"/);

  for (const provider of ['claude', 'codex', 'gemini', 'opencode', 'cursor', 'hermes']) {
    const icon = await fs.readFile(path.resolve(`public/icons/providers/${provider}.svg`), 'utf8');
    assert.match(icon, /<svg/);
    assert.match(icon, new RegExp(`aria-label="[^"]+"`));
  }
});
