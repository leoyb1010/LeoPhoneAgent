import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import multer from 'multer';

import { getDatabasePath, treasuryDb, type TreasureItem, type TreasureKind } from '@/modules/database/index.js';

import { readArtifact } from './harness-artifacts.service.js';
import { getHarnessManager } from './harness-session.service.js';
import {
  treasuryCaptureHttpUrl,
  treasuryCaptureCompactItem,
  treasuryCaptureKindForMime,
  treasuryCaptureSafeExtension,
  treasuryCaptureVerifyPdfFile,
} from './treasury-capture-policy.js';

const router = express.Router();
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 20;
const treasuryRoot = path.join(path.dirname(getDatabasePath()), 'treasury');
const filesRoot = path.join(treasuryRoot, 'files');
const stagingRoot = path.join(treasuryRoot, '.staging');
for (const directory of [filesRoot, stagingRoot]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

const upload = multer({
  dest: stagingRoot,
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
});

const PDF_JXA = `
ObjC.import('PDFKit');
function run(argv) {
  const document = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!document) return '[]';
  const pages = [];
  const count = Math.min(Number(document.pageCount), 500);
  let total = 0;
  for (let index = 0; index < count && total < 2000000; index += 1) {
    const page = document.pageAtIndex(index);
    const text = page && page.string ? ObjC.unwrap(page.string) : '';
    pages.push(text || '');
    total += (text || '').length;
  }
  return JSON.stringify(pages);
}`;

function userId(req: express.Request): number {
  const value = Number((req as express.Request & { user?: { id?: unknown } }).user?.id);
  if (!Number.isInteger(value) || value <= 0) throw new Error('Authenticated user is missing');
  return value;
}

function safeText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => typeof entry === 'string' && entry.trim() ? [entry.trim().slice(0, 100)] : []).slice(0, 100)
    : [];
}

function baseItem(input: Partial<TreasureItem> & Pick<TreasureItem, 'kind' | 'source_label'>): TreasureItem {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), schema_version: 1, kind: input.kind, title: input.title ?? null,
    source_uri: input.source_uri ?? null, source_app: input.source_app ?? 'mac.local',
    source_label: input.source_label, original_text: input.original_text ?? null,
    body_ref: input.body_ref ?? null, preview_ref: input.preview_ref ?? null,
    mime_type: input.mime_type ?? null, byte_count: input.byte_count ?? 0,
    content_digest: input.content_digest ?? null, summary: input.summary ?? null,
    annotation: input.annotation ?? null, tags: input.tags ?? [], collection_ids: [],
    pinned: false, archived: false, reading_state: input.kind === 'link' ? 'unread' : 'none',
    reading_progress: 0, created_at: now, updated_at: now, last_opened_at: null,
    processing_state: input.processing_state ?? (input.kind === 'text' || input.kind === 'note' ? 'ready' : 'queued'),
    processing_error_code: input.processing_error_code ?? null,
    sync_state: 'pending', origin_device_id: 'mac-local', deleted_at: null,
  };
}

function persistFile(user: number, sourcePath: string, originalName: string, mime: string, sourceApp: string): TreasureItem {
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Unsupported file');
  const id = randomUUID();
  const extension = treasuryCaptureSafeExtension(originalName);
  const relativeRef = `files/${id}${extension}`;
  const destination = path.join(treasuryRoot, relativeRef);
  const digest = createHash('sha256');
  const input = fs.openSync(sourcePath, 'r');
  let output: number | null = null;
  let byteCount = 0;
  try {
    output = fs.openSync(destination, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let read = 0;
    while ((read = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) {
      byteCount += read;
      if (byteCount > MAX_FILE_BYTES) throw new Error('Unsupported file');
      digest.update(buffer.subarray(0, read));
      let written = 0;
      while (written < read) written += fs.writeSync(output, buffer, written, read - written, null);
    }
    fs.fsyncSync(output);
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  } finally {
    fs.closeSync(input);
    if (output !== null) fs.closeSync(output);
  }
  const kind = sourceApp === 'chat.artifact' ? 'artifact' : treasuryCaptureKindForMime(mime);
  const isPdf = mime === 'application/pdf' || extension === '.pdf';
  const unsupportedError = !isPdf && kind === 'image' ? 'ocr_engine_unavailable'
    : !isPdf && kind === 'document' ? 'text_extractor_unavailable'
      : !isPdf && kind === 'audio' ? 'transcription_not_authorized' : null;
  const item = baseItem({
    kind,
    title: path.basename(originalName).slice(0, 500),
    source_app: sourceApp,
    source_label: sourceApp === 'chat.artifact' ? '聊天 Artifact' : 'Mac 文件',
    body_ref: relativeRef,
    mime_type: mime || 'application/octet-stream',
    byte_count: byteCount,
    content_digest: digest.digest('hex'),
    processing_state: isPdf ? 'queued' : unsupportedError ? 'partial' : 'ready',
    processing_error_code: unsupportedError,
  });
  try {
    const saved = treasuryDb.save(user, { ...item, id }).item;
    if (saved.id !== id) fs.rmSync(destination, { force: true });
    if (saved.id === id && process.platform === 'darwin' && isPdf) {
      setImmediate(() => enrichPdfInBackground(user, saved, destination));
    }
    return saved;
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  }
}

function enrichPdfInBackground(user: number, item: TreasureItem, absolutePath: string): void {
  const pendingJob = treasuryDb.readyJobForItem(item.id, 'extract_text');
  const jobId = pendingJob && treasuryDb.claimJob(pendingJob.id) ? pendingJob.id : null;
  const processingItem = treasuryDb.get(user, [item.id])[0];
  if (processingItem) {
    treasuryDb.update(user, {
      ...processingItem, processing_state: 'processing', processing_error_code: null,
      updated_at: new Date().toISOString(), sync_state: 'pending',
    });
  }
  execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PDF_JXA, absolutePath], {
    timeout: 30_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
  }, (error, stdout) => {
    const current = treasuryDb.get(user, [item.id])[0];
    if (!current) return;
    if (error) {
      treasuryDb.update(user, {
        ...current, processing_state: 'partial', processing_error_code: 'pdf_text_unavailable',
        updated_at: new Date().toISOString(), sync_state: 'pending',
      });
      if (jobId) treasuryDb.failJob(jobId, 'pdf_text_unavailable');
      return;
    }
    try {
      const parsed: unknown = JSON.parse(stdout.trim() || '[]');
      const pages = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
      if (!treasuryDb.applyDocumentExtraction(user, item.id, pages)) {
        treasuryDb.update(user, {
          ...current, processing_state: 'partial', processing_error_code: 'pdf_text_unavailable',
          updated_at: new Date().toISOString(), sync_state: 'pending',
        });
        if (jobId) treasuryDb.failJob(jobId, 'pdf_text_unavailable');
      } else if (jobId) {
        treasuryDb.completeJob(jobId);
      }
    } catch {
      treasuryDb.update(user, {
        ...current, processing_state: 'partial', processing_error_code: 'pdf_text_unavailable',
        updated_at: new Date().toISOString(), sync_state: 'pending',
      });
      if (jobId) treasuryDb.failJob(jobId, 'pdf_text_unavailable');
    }
  });
}

function managedTreasuryFile(relativeRef: string | null): string | null {
  if (!relativeRef?.startsWith('files/') || relativeRef.includes('//') ||
      path.isAbsolute(relativeRef) || relativeRef.includes('\\')) return null;
  const candidate = path.resolve(treasuryRoot, relativeRef);
  const lexicalRelative = path.relative(treasuryRoot, candidate);
  if (!lexicalRelative || lexicalRelative.startsWith(`..${path.sep}`) || lexicalRelative === '..') return null;
  try {
    const real = fs.realpathSync(candidate);
    const realRelative = path.relative(fs.realpathSync(treasuryRoot), real);
    if (!realRelative || realRelative.startsWith(`..${path.sep}`) || realRelative === '..') return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch { return null; }
}

router.get('/', (req, res) => {
  try {
    const query = safeText(req.query.q, 512);
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));
    const items = treasuryDb.query(userId(req), query, limit);
    return res.json({ items: items.map(treasuryCaptureCompactItem) });
  } catch (error) {
    console.error('Treasury query failed:', error instanceof Error ? error.name : 'unknown');
    return res.status(400).json({ error: 'Treasury query failed' });
  }
});

router.get('/:id/highlights', (req, res) => {
  try {
    return res.json({ highlights: treasuryDb.highlights(userId(req), safeText(req.params.id, 200)) });
  } catch (error) {
    console.error('Treasury highlights failed:', error instanceof Error ? error.name : 'unknown');
    return res.status(400).json({ error: 'Treasury highlights failed' });
  }
});

router.post('/:id/highlights', (req, res) => {
  try {
    const highlight = treasuryDb.addHighlight(userId(req), {
      itemId: safeText(req.params.id, 200),
      quoteText: typeof req.body?.quote_text === 'string' ? req.body.quote_text : '',
      note: typeof req.body?.note === 'string' ? req.body.note : null,
      startOffset: Number(req.body?.start_offset),
      endOffset: Number(req.body?.end_offset),
      pageNumber: req.body?.page_number == null ? null : Number(req.body.page_number),
    });
    return res.status(201).json({ highlight });
  } catch (error) {
    console.error('Treasury highlight save failed:', error instanceof Error ? error.name : 'unknown');
    return res.status(400).json({ error: 'Treasury highlight save failed' });
  }
});

router.delete('/:id/highlights/:highlightId', (req, res) => {
  try {
    const deleted = treasuryDb.deleteHighlight(
      userId(req), safeText(req.params.id, 200), safeText(req.params.highlightId, 200),
    );
    return deleted ? res.status(204).end() : res.status(404).json({ error: 'Highlight not found' });
  } catch (error) {
    console.error('Treasury highlight delete failed:', error instanceof Error ? error.name : 'unknown');
    return res.status(400).json({ error: 'Treasury highlight delete failed' });
  }
});

router.get('/:id', (req, res) => {
  try {
    const item = treasuryDb.get(userId(req), [safeText(req.params.id, 200)])[0];
    if (!item) return res.status(404).json({ error: 'Treasury item not found' });
    const maxChars = Math.max(500, Math.min(Number(req.query.max_chars) || 100_000, 200_000));
    const availableBody = item.original_text;
    const body = availableBody?.slice(0, maxChars) ?? null;
    return res.json({
      item: { ...treasuryCaptureCompactItem(item), annotation: item.annotation },
      body,
      body_status: availableBody === null ? (item.body_ref ? 'not_extracted' : 'unavailable') : 'available',
      truncated: availableBody !== null && availableBody.length > maxChars,
    });
  } catch (error) {
    console.error('Treasury detail failed:', error instanceof Error ? error.name : 'unknown');
    return res.status(400).json({ error: 'Treasury detail failed' });
  }
});

router.post('/:id/retry', async (req, res) => {
  try {
    const user = userId(req);
    const item = treasuryDb.get(user, [safeText(req.params.id, 200)])[0];
    if (!item) return res.status(404).json({ error: 'Treasury item not found' });
    if (item.processing_error_code !== 'pdf_text_unavailable') {
      return res.status(409).json({ error: 'This processing failure is not retryable' });
    }
    const source = managedTreasuryFile(item.body_ref);
    if (!source) return res.status(410).json({ error: 'Treasury source file is unavailable' });
    const validPdf = await treasuryCaptureVerifyPdfFile(source, {
      byteCount: item.byte_count, digest: item.content_digest, mime: item.mime_type,
    }, MAX_FILE_BYTES);
    if (!validPdf) return res.status(409).json({ error: 'Treasury source file failed integrity validation' });
    if (treasuryDb.retryFailedJobs(item.id, 'extract_text') < 1) {
      return res.status(409).json({ error: 'No failed Treasury job is available to retry' });
    }
    const queued = treasuryDb.update(user, {
      ...item, processing_state: 'queued', processing_error_code: null,
      updated_at: new Date().toISOString(), sync_state: 'pending',
    });
    if (!queued) return res.status(404).json({ error: 'Treasury item not found' });
    setImmediate(() => enrichPdfInBackground(user, queued, source));
    return res.status(202).json({ item: treasuryCaptureCompactItem(queued) });
  } catch (error) {
    console.error('Treasury retry failed:', error instanceof Error ? error.name : 'unknown');
    return res.status(400).json({ error: 'Treasury retry failed' });
  }
});

router.patch('/:id/reading', (req, res) => {
  try {
    const rawState = safeText(req.body?.reading_state, 20);
    const state = ['none', 'unread', 'reading', 'read'].includes(rawState)
      ? rawState as 'none' | 'unread' | 'reading' | 'read' : null;
    const progress = Number(req.body?.reading_progress);
    if (!state || !Number.isFinite(progress)) return res.status(400).json({ error: 'Invalid reading update' });
    const item = treasuryDb.updateReading(
      userId(req), safeText(req.params.id, 200), state, progress, req.body?.opened !== false,
    );
    return item ? res.json({ item: treasuryCaptureCompactItem(item) })
      : res.status(404).json({ error: 'Treasury item not found' });
  } catch (error) {
    console.error('Treasury reading update failed:', error instanceof Error ? error.name : 'unknown');
    return res.status(400).json({ error: 'Treasury reading update failed' });
  }
});

router.post('/', (req, res) => {
  try {
    const rawKind = safeText(req.body?.kind, 20);
    const kind: TreasureKind = rawKind === 'link' ? 'link' : rawKind === 'note' ? 'note' : 'text';
    const content = safeText(req.body?.content, rawKind === 'link' ? 16_384 : 2_000_000);
    if (!content) return res.status(400).json({ error: 'content is required' });
    const parsedUrl = kind === 'link' ? treasuryCaptureHttpUrl(content) : null;
    if (kind === 'link' && !parsedUrl) return res.status(400).json({ error: 'Only HTTP(S) links without embedded credentials are supported' });
    const sourceUri = parsedUrl?.toString() ?? null;
    const item = baseItem({
      kind,
      title: safeText(req.body?.title, 500) || null,
      source_uri: sourceUri,
      source_label: parsedUrl ? parsedUrl.hostname : kind === 'note' ? 'Mac 笔记' : 'Mac 文本',
      original_text: sourceUri ? null : content,
      tags: stringArray(req.body?.tags),
    });
    return res.status(201).json({ item: treasuryCaptureCompactItem(treasuryDb.save(userId(req), item).item) });
  } catch (error) {
    console.error('Treasury save failed:', error instanceof Error ? error.name : 'unknown');
    return res.status(400).json({ error: 'Treasury save failed' });
  }
});

router.post('/files', upload.array('files', MAX_FILES), (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  try {
    if (!files.length) return res.status(400).json({ error: 'files are required' });
    const items = files.map((file) => persistFile(userId(req), file.path, file.originalname, file.mimetype, 'mac.file'));
    return res.status(201).json({ items: items.map(treasuryCaptureCompactItem) });
  } catch (error) {
    console.error('Treasury file capture failed:', error instanceof Error ? error.name : 'unknown');
    return res.status(400).json({ error: 'File capture failed' });
  } finally {
    for (const file of files) fs.rmSync(file.path, { force: true });
  }
});

router.post('/artifacts', (req, res) => {
  try {
    const sessionId = safeText(req.body?.session_id, 200);
    const name = safeText(req.body?.name, 1_000);
    const session = getHarnessManager().get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const artifact = readArtifact(session, name);
    if (!artifact) return res.status(404).json({ error: 'Artifact not found' });
    const item = persistFile(userId(req), artifact.path, artifact.name, artifact.mime, 'chat.artifact');
    return res.status(201).json({ item: treasuryCaptureCompactItem(item) });
  } catch (error) {
    console.error('Treasury artifact capture failed:', error instanceof Error ? error.name : 'unknown');
    return res.status(400).json({ error: 'Artifact capture failed' });
  }
});

export default router;
