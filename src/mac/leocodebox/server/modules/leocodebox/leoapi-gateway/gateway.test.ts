import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderStore } from '../provider-store.service.js';

import { buildUpstreamHeaders, parseAnthropicUsage, parseGatewayToken, selectUpstreamChain } from './gateway.service.js';
import { __resetGatewayMeter, gatewayMeterSnapshot, recordGatewayRequest } from './gateway-meter.js';
import { __resetCompaction, compactionSnapshot, compactMessages, compactRequestBody, recordCompaction } from './gateway-compaction.js';
import { upstreamUrl } from './gateway.routes.js';

function fakeStore(): ProviderStore {
  return {
    providers: [
      { id: 'n1', target: 'claude', name: 'Node-1', baseUrl: 'https://a.example', apiKey: 'k1' },
      { id: 'n2', target: 'claude', name: 'Node-2', baseUrl: 'https://b.example', apiKey: 'k2' },
      { id: 'c1', target: 'codex', name: 'Codex-1', baseUrl: 'https://c.example', apiKey: 'k3' },
    ] as ProviderStore['providers'],
    activeByTarget: { claude: 'n1' },
    routingSlots: { claude: { background: { providerId: 'n2' } } },
    healthMonitor: { enabled: true, intervalMinutes: 5, autoFailoverTargets: [] },
  };
}

test('parses usage from a streaming Anthropic SSE response', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":1200,"cache_read_input_tokens":800}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"text":"hi"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":345}}',
    '',
  ].join('\n');
  const usage = parseAnthropicUsage(sse);
  assert.equal(usage.model, 'claude-sonnet-4-5');
  assert.equal(usage.inputTokens, 1200);
  assert.equal(usage.cacheReadTokens, 800);
  assert.equal(usage.outputTokens, 345);
});

test('parses usage from a non-streaming JSON response', () => {
  const json = JSON.stringify({ model: 'claude-opus-4-8', usage: { input_tokens: 50, output_tokens: 700 } });
  const usage = parseAnthropicUsage(json);
  assert.equal(usage.model, 'claude-opus-4-8');
  assert.equal(usage.inputTokens, 50);
  assert.equal(usage.outputTokens, 700);
});

test('malformed body meters as zero without throwing', () => {
  const usage = parseAnthropicUsage('data: {not json\n\ngarbage');
  assert.equal(usage.inputTokens, 0);
  assert.equal(usage.outputTokens, 0);
  assert.equal(usage.model, null);
});

test('upstream headers drop the gateway token/host and inject the real key', () => {
  const headers = buildUpstreamHeaders(
    { host: '127.0.0.1:3001', 'x-api-key': 'lgw:node-1', authorization: 'Bearer lgw:node-1', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    'sk-real-upstream-key',
  );
  assert.equal(headers['x-api-key'], 'sk-real-upstream-key');
  assert.equal(headers['authorization'], 'Bearer sk-real-upstream-key');
  assert.equal(headers['host'], undefined);
  assert.equal(headers['anthropic-version'], '2023-06-01');
});

test('parseGatewayToken reads x-api-key and Bearer, rejects non-gateway tokens', () => {
  assert.equal(parseGatewayToken({ 'x-api-key': 'lgw:claude' }), 'claude');
  assert.equal(parseGatewayToken({ authorization: 'Bearer lgw:claude:background' }), 'claude:background');
  assert.equal(parseGatewayToken({ 'x-api-key': 'sk-real-key' }), null);
  assert.equal(parseGatewayToken({}), null);
});

test('target token resolves active node first, then same-target siblings (failover chain)', () => {
  const chain = selectUpstreamChain(fakeStore(), 'claude');
  assert.deepEqual(chain.map((u) => u.providerId), ['n1', 'n2']); // active n1, then sibling n2
  assert.equal(chain[0].baseUrl, 'https://a.example');
  assert.equal(chain[0].apiKey, 'k1');
});

test('slot token resolves the bound node first, then siblings', () => {
  const chain = selectUpstreamChain(fakeStore(), 'claude:background');
  assert.deepEqual(chain.map((u) => u.providerId), ['n2', 'n1']); // background→n2 primary, n1 sibling
});

test('pinned providerId token yields exactly that node (no failover)', () => {
  const chain = selectUpstreamChain(fakeStore(), 'n2');
  assert.deepEqual(chain.map((u) => u.providerId), ['n2']);
});

test('unknown token yields an empty chain', () => {
  assert.deepEqual(selectUpstreamChain(fakeStore(), 'nope'), []);
});

test('meter aggregates today totals and keeps a recent ring', () => {
  __resetGatewayMeter();
  recordGatewayRequest({ provider: 'Leoapi-A', model: 'claude-sonnet-4-5', inputTokens: 100, outputTokens: 200, cacheReadTokens: 10, status: 200 });
  recordGatewayRequest({ provider: 'Leoapi-A', model: 'claude-sonnet-4-5', inputTokens: 300, outputTokens: 50, cacheReadTokens: 0, status: 200 });
  const snap = gatewayMeterSnapshot();
  assert.equal(snap.today.requests, 2);
  assert.equal(snap.today.inputTokens, 400);
  assert.equal(snap.today.outputTokens, 250);
  assert.equal(snap.recent.length, 2);
  assert.ok(snap.today.costUsd >= 0);
  // Single node, no failures → calm routing signal.
  assert.equal(snap.routing.activeNodes, 1);
  assert.equal(snap.routing.retries, 0);
});

test('routing signal counts distinct nodes and failover attempts', () => {
  __resetGatewayMeter();
  // A retryable upstream error on node A (metered with a 5xx), then the retry
  // lands on node B and succeeds — routing should read 2 nodes, 1 failover.
  recordGatewayRequest({ provider: 'Node-A', model: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, status: 503 });
  recordGatewayRequest({ provider: 'Node-B', model: 'claude-sonnet-4-5', inputTokens: 120, outputTokens: 80, cacheReadTokens: 0, status: 200 });
  const snap = gatewayMeterSnapshot();
  assert.equal(snap.routing.activeNodes, 2);
  assert.equal(snap.routing.retries, 1);
  assert.equal(snap.routing.window, 2);
});

const BIG = 'x'.repeat(5000);

/**
 * A 45-turn body. With KEEP_FIRST=1, KEEP_RECENT=20 and a boundary quantized to
 * blocks of 20, the trim window is indices 1..19: [0] first (kept), [2] an
 * oversized tool_result inside the window (trimmed), [3] an oversized TEXT
 * block (never trimmed), [30] an oversized tool_result in the recent tail
 * (kept).
 */
function longMessagesBody() {
  const messages: Array<{ role: string; content: unknown }> = [];
  messages.push({ role: 'user', content: 'first turn: the task' }); // 0 (kept)
  messages.push({ role: 'assistant', content: 'thinking' }); // 1
  messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: BIG }] }); // 2 → trim
  messages.push({ role: 'user', content: [{ type: 'text', text: BIG }] }); // 3 text → keep
  for (let i = 4; i < 45; i += 1) {
    if (i === 30) messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't30', content: BIG }] }); // recent → keep
    else messages.push({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` });
  }
  return { system: 'SYSTEM PROMPT', model: 'claude-sonnet-4-5', messages };
}

test('compaction trims only old oversized tool_result, keeping system/first/recent/text', () => {
  const input = longMessagesBody();
  const before = JSON.stringify(input);
  const { body, stats } = compactMessages(input);
  assert.equal(stats.touchedBlocks, 1);
  assert.equal(stats.savedChars, 3000); // 5000 - 2000 kept
  const msgs = body.messages as Array<{ role: string; content: unknown }>;
  // system + first turn untouched.
  assert.equal(body.system, 'SYSTEM PROMPT');
  assert.deepEqual(msgs[0], input.messages[0]);
  // middle tool_result trimmed (shorter than original, carries the marker).
  const trimmed = (msgs[2].content as Array<{ content: string }>)[0].content;
  assert.ok(trimmed.length < 5000 && trimmed.includes('leocodebox 已裁剪'));
  // middle TEXT block never trimmed.
  assert.equal((msgs[3].content as Array<{ text: string }>)[0].text.length, 5000);
  // recent tool_result (index 24) never trimmed.
  assert.equal((msgs[30].content as Array<{ content: string }>)[0].content.length, 5000);
  // input object was not mutated.
  assert.equal(JSON.stringify(input), before);
});

test('compaction is a no-op below the length threshold', () => {
  const input = { system: 's', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: BIG }] }] };
  const { body, stats } = compactMessages(input);
  assert.equal(stats.touchedBlocks, 0);
  assert.equal(body, input); // same reference → truly untouched
});

test('compactRequestBody trims a long JSON body and fails open on anything else', () => {
  const long = compactRequestBody(Buffer.from(JSON.stringify(longMessagesBody())));
  assert.ok(long);
  assert.equal(long.stats.touchedBlocks, 1);
  assert.ok(JSON.parse(long.body.toString()).messages[2].content[0].content.includes('已裁剪'));
  assert.equal(compactRequestBody(Buffer.from('not json')), null); // malformed → use original
  assert.equal(compactRequestBody(Buffer.from(JSON.stringify({ messages: [] }))), null); // nothing to trim
});

test('upstreamUrl does not double a /v1 the provider baseUrl already has', () => {
  assert.equal(upstreamUrl('https://relay.example/v1', '/v1/messages'), 'https://relay.example/v1/messages');
  assert.equal(upstreamUrl('https://relay.example/v1/', '/v1/messages'), 'https://relay.example/v1/messages');
  assert.equal(upstreamUrl('https://api.example', '/v1/messages'), 'https://api.example/v1/messages');
  // A non-/v1 path is appended verbatim either way.
  assert.equal(upstreamUrl('https://relay.example/v1', '/health'), 'https://relay.example/v1/health');
  assert.equal(upstreamUrl('https://relay.example/v1', '/v1/messages?beta=1'), 'https://relay.example/v1/messages?beta=1');
});

test('the compaction boundary is stable between turns (keeps the prompt cache)', () => {
  const big = 'y'.repeat(5000);
  const build = (n: number) => ({
    system: 's',
    messages: Array.from({ length: n }, (_, i) => (
      i === 2
        ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: big }] }
        : { role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }
    )),
  });
  // Two consecutive turns must produce an identical prefix for message 2 —
  // a boundary that advanced every turn re-wrote already-sent history.
  const a = compactMessages(build(30));
  const b = compactMessages(build(31));
  const at = (r: { body: { messages?: unknown } }) => JSON.stringify((r.body.messages as unknown[])[2]);
  assert.equal(at(a), at(b));
});

test('compaction snapshot accumulates savings', () => {
  __resetCompaction();
  recordCompaction({ touchedBlocks: 2, savedChars: 1200 });
  recordCompaction({ touchedBlocks: 1, savedChars: 300 });
  assert.deepEqual(compactionSnapshot(), { requests: 2, touchedBlocks: 3, savedChars: 1500 });
});
