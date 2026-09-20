import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyEvent, emptyView } from './model';
import { toolImageDataUrls } from './session-tool-image';

test('它看的图你也能看见', () => {
  assert.deepEqual(toolImageDataUrls([{ mimeType: 'image/png', data: 'AAAABBBB' }]), ['data:image/png;base64,AAAABBBB']);
  assert.deepEqual(toolImageDataUrls([{ type: 'text', text: 'Read image file' }]), []);
  assert.deepEqual(toolImageDataUrls(null), []);
  let view = applyEvent(emptyView(), {
    event: 'tool.started', tool: 'read', tool_use_id: 'r1', preview: 'shot.png',
  });
  view = applyEvent(view, {
    event: 'tool.completed', tool: 'read', tool_use_id: 'r1', output: 'Read image file [image/png]',
    images: [{ mimeType: 'image/png', data: 'AAAABBBB' }],
  });
  const row = view.rows.find((item) => item.k === 'tool');
  assert.equal(row && row.k === 'tool' ? row.images?.[0] : '', 'data:image/png;base64,AAAABBBB');
});

test('2.0 工具图不进输入栏按钮', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const flow = readFileSync(fileURLToPath(new URL('./flow.tsx', import.meta.url)), 'utf8');
  const model = readFileSync(fileURLToPath(new URL('./model.ts', import.meta.url)), 'utf8');
  assert.match(model, /toolImageDataUrls/);
  assert.match(flow, /row\.images/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /看的图|toolImageDataUrls|sessionToolImages/);
});
