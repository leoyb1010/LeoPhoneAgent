/**
 * Agent profiles (智能体档案) CRUD + JSON import/export.
 *
 * A profile is a named launch preset. Launching one is a pure frontend action
 * (it dispatches the composer's existing preference events); the server only
 * owns storage, so these routes are plain owner-scoped CRUD over
 * `agentProfilesDb`, plus bulk import/export for portability.
 */

import express from 'express';

import { agentProfilesDb } from '@/modules/database/index.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

const EXPORT_VERSION = 1;
const MAX_IMPORT = 500;

/** Field length caps — mirrors the repo's normalize limits, enforced on the interactive write path. */
const MAX_LEN: Record<string, number> = {
  name: 120, emoji: 16, model: 80, effort: 80, permissionMode: 80, openingPrompt: 8000, notes: 8000,
};

/**
 * Reject over-length fields on create/update so a client's data is never
 * silently truncated. The repo's normalize layer still clamps defensively for
 * stored/imported data; this only guards fresh interactive input.
 */
function assertProfileLengths(input: unknown): void {
  const src = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  for (const [field, max] of Object.entries(MAX_LEN)) {
    const value = src[field];
    if (typeof value === 'string' && [...value.trim()].length > max) {
      throw new AppError(`${field} exceeds ${max} characters`, {
        code: 'AGENT_PROFILE_FIELD_TOO_LONG',
        statusCode: 400,
      });
    }
  }
}

const isPlainObject = (value: unknown): boolean => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

function readUserId(req: express.Request): number {
  const userId = Number((req as express.Request & { user?: { id?: unknown } }).user?.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new AppError('Authenticated user is missing', { code: 'UNAUTHENTICATED', statusCode: 401 });
  }
  return userId;
}

function readProfileId(req: express.Request): string {
  const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
  if (!id) {
    throw new AppError('Profile id is required', { code: 'AGENT_PROFILE_ID_REQUIRED', statusCode: 400 });
  }
  return id;
}

// List all of the user's profiles.
router.get('/', asyncHandler(async (req, res) => {
  const userId = readUserId(req);
  res.json(createApiSuccessResponse({ profiles: agentProfilesDb.listProfiles(userId) }));
}));

// Export every profile as a portable JSON document.
router.get('/export', asyncHandler(async (req, res) => {
  const userId = readUserId(req);
  const profiles = agentProfilesDb.listProfiles(userId);
  res.json(createApiSuccessResponse({
    version: EXPORT_VERSION,
    kind: 'leocodebox-agent-profiles',
    profiles,
  }));
}));

// Fetch one profile.
router.get('/:id', asyncHandler(async (req, res) => {
  const userId = readUserId(req);
  const profile = agentProfilesDb.getProfile(userId, readProfileId(req));
  if (!profile) {
    throw new AppError('Profile not found', { code: 'AGENT_PROFILE_NOT_FOUND', statusCode: 404 });
  }
  res.json(createApiSuccessResponse({ profile }));
}));

// Create a profile.
router.post('/', asyncHandler(async (req, res) => {
  const userId = readUserId(req);
  assertProfileLengths(req.body);
  const profile = agentProfilesDb.createProfile(userId, req.body);
  res.status(201).json(createApiSuccessResponse({ profile }));
}));

// Import a batch of profiles (each gets a fresh id — never clobbers existing ones).
router.post('/import', asyncHandler(async (req, res) => {
  const userId = readUserId(req);
  const body = req.body as { profiles?: unknown } | unknown;
  const rawList = Array.isArray(body)
    ? body
    : Array.isArray((body as { profiles?: unknown })?.profiles)
      ? (body as { profiles: unknown[] }).profiles
      : null;
  if (!rawList || !rawList.every(isPlainObject)) {
    throw new AppError('Import payload must be an array of profile objects', {
      code: 'AGENT_PROFILE_IMPORT_INVALID',
      statusCode: 400,
    });
  }
  if (rawList.length > MAX_IMPORT) {
    throw new AppError(`Import exceeds the ${MAX_IMPORT}-profile limit`, {
      code: 'AGENT_PROFILE_IMPORT_TOO_LARGE',
      statusCode: 413,
    });
  }
  rawList.forEach(assertProfileLengths);
  const imported = agentProfilesDb.importProfiles(userId, rawList);
  res.status(201).json(createApiSuccessResponse({ profiles: imported, count: imported.length }));
}));

// Update a profile.
router.put('/:id', asyncHandler(async (req, res) => {
  const userId = readUserId(req);
  assertProfileLengths(req.body);
  const updated = agentProfilesDb.updateProfile(userId, readProfileId(req), req.body);
  if (!updated) {
    throw new AppError('Profile not found', { code: 'AGENT_PROFILE_NOT_FOUND', statusCode: 404 });
  }
  res.json(createApiSuccessResponse({ profile: updated }));
}));

// Delete a profile.
router.delete('/:id', asyncHandler(async (req, res) => {
  const userId = readUserId(req);
  const removed = agentProfilesDb.deleteProfile(userId, readProfileId(req));
  if (!removed) {
    throw new AppError('Profile not found', { code: 'AGENT_PROFILE_NOT_FOUND', statusCode: 404 });
  }
  res.json(createApiSuccessResponse({ removed: true }));
}));

export default router;
