import assert from 'node:assert/strict';
import test from 'node:test';

import {
  treasuryCaptureKindForMime,
  treasuryCaptureHttpUrl,
  treasuryCaptureCompactItem,
  treasuryCaptureSafeExtension,
} from './treasury-capture-policy.js';

test('treasury local capture maps supported media without relying on file names', () => {
  assert.equal(treasuryCaptureKindForMime('image/png'), 'image');
  assert.equal(treasuryCaptureKindForMime('audio/mpeg'), 'audio');
  assert.equal(treasuryCaptureKindForMime('video/mp4'), 'video');
  assert.equal(treasuryCaptureKindForMime('application/pdf'), 'document');
});

test('treasury link capture accepts only credential-free HTTP(S) URLs', () => {
  assert.equal(treasuryCaptureHttpUrl('https://example.com/path')?.hostname, 'example.com');
  assert.equal(treasuryCaptureHttpUrl('file:///etc/passwd'), null);
  assert.equal(treasuryCaptureHttpUrl('https://token@example.com/private'), null);
  assert.equal(treasuryCaptureHttpUrl('not a URL'), null);
});

test('treasury local capture never preserves unsafe or oversized extensions', () => {
  assert.equal(treasuryCaptureSafeExtension('report.PDF'), '.pdf');
  assert.equal(treasuryCaptureSafeExtension('../../secret'), '');
  assert.equal(treasuryCaptureSafeExtension('payload.sh/../../ssh'), '');
  assert.equal(treasuryCaptureSafeExtension('archive.thisextensionistoolong'), '');
});

test('treasury list projection never returns a full body or local file reference', () => {
  const item = {
    id: 'compact', schema_version: 1, kind: 'text' as const, title: '标题',
    source_uri: null, source_app: 'test', source_label: '文本',
    original_text: 'x'.repeat(2_000), body_ref: 'files/private.txt', preview_ref: null,
    mime_type: 'text/plain', byte_count: 2_000, content_digest: null, summary: null,
    annotation: null, tags: [], collection_ids: [], pinned: false, archived: false,
    reading_state: 'none' as const, reading_progress: 0, created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(), last_opened_at: null, processing_state: 'ready' as const,
    processing_error_code: null, sync_state: 'local' as const, origin_device_id: 'test', deleted_at: null,
  };
  const compact = treasuryCaptureCompactItem(item);
  assert.equal(compact.snippet.length, 400);
  assert.equal('original_text' in compact, false);
  assert.equal('body_ref' in compact, false);
});
