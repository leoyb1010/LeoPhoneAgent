import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import type { ErrorRequestHandler } from 'express';

import { findAppRoot } from '@/utils/runtime-paths.js';
import { listRecycled, restoreRecycled } from '@/shared/recycle.js';
import { listConfigBackups } from '@/shared/utils.js';

import cliToolsRoutes, { CLI_TOOLS, getCliToolStatus } from './cli-tools.routes.js';
import gatewayControlRoutes from './leoapi-gateway/gateway-control.routes.js';
import { collectDiagnostics } from './diagnostics.service.js';
import { collectDoctorReport } from './doctor.service.js';
import feedbackUpdateRoutes from './feedback-update.routes.js';
import loginSnapshotRoutes from './login-snapshot.routes.js';
import missionRoutes from './mission.routes.js';
import kernelRoutes from './pi-kernel/kernel.routes.js';
import providerRoutingRoutes from './provider-routing.routes.js';
import providerSwitchRoutes from './provider-switch.routes.js';
import worktreeRoutes from './worktree.routes.js';

const router = express.Router();

router.use('/cli', cliToolsRoutes);
router.use('/gateway', gatewayControlRoutes);
router.use('/routing', providerRoutingRoutes);
router.use('/worktrees', worktreeRoutes);
router.use('/missions', missionRoutes);
router.use('/kernel', kernelRoutes);
router.use('/login-snapshots', loginSnapshotRoutes);
router.use(feedbackUpdateRoutes);
router.use(providerSwitchRoutes);

// One-click shareable diagnostics: CLI inventory + Leoapi state, with API keys
// masked and home paths collapsed. No raw logs, no secrets.
router.get('/diagnostics', async (_req, res, next) => {
  try {
    const tools = await Promise.all(
      Object.values(CLI_TOOLS).map((tool) => getCliToolStatus(tool, { checkLatest: false })),
    );
    const appRoot = findAppRoot(path.dirname(fileURLToPath(import.meta.url)));
    res.json({ success: true, report: await collectDiagnostics(appRoot, tools) });
  } catch (error) {
    next(error);
  }
});

// Read-only readiness assessment: per-check ok/warn/fail for CLIs + Leoapi nodes.
router.get('/doctor', async (_req, res, next) => {
  try {
    const tools = await Promise.all(
      Object.values(CLI_TOOLS).map((tool) => getCliToolStatus(tool, { checkLatest: false })),
    );
    res.json({ success: true, report: await collectDoctorReport(tools) });
  } catch (error) {
    next(error);
  }
});

// Recoverable-delete trash: list soft-deleted skills and restore them.
router.get('/recycle', async (_req, res, next) => {
  try {
    res.json({ success: true, entries: await listRecycled() });
  } catch (error) {
    next(error);
  }
});

router.post('/recycle/:id/restore', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      res.status(400).json({ success: false, error: 'Invalid recycle id.' });
      return;
    }
    // restored:false means the original path is occupied — surfaced honestly, not as success.
    const result = await restoreRecycled(id);
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// Read-only list of config recovery backups (~/.leocodebox/config-backups); no absolute paths.
router.get('/config-backups', async (_req, res, next) => {
  try {
    res.json({ success: true, backups: await listConfigBackups() });
  } catch (error) {
    next(error);
  }
});

const localRouteErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : 'leocodebox local route failed.';
  res.status(statusCode).json({ success: false, error: message });
};
router.use(localRouteErrorHandler);

export default router;
