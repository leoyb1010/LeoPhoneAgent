#!/usr/bin/env node
// Load environment variables before other imports execute
import './load-env.js';
import fs from 'fs';
import path from 'path';
import http from 'http';

import express from 'express';
import type { ErrorRequestHandler } from 'express';

import { AppError } from '@/shared/utils.js';
import { getConnectableHost } from '@/shared/network-hosts.js';
import { logger } from '@/modules/logging/index.js';

import { findAppRoot, getModuleDir } from './utils/runtime-paths.js';
import gitRoutes from './modules/git/index.js';
import authRoutes from './routes/auth.js';
import cursorRoutes from './routes/cursor.js';
import taskmasterRoutes from './modules/taskmaster/index.js';
import mcpUtilsRoutes from './routes/mcp-utils.js';
import commandsRoutes from './routes/commands.js';
import settingsRoutes from './routes/settings.js';
import agentRoutes from './modules/agent/index.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import userRoutes from './routes/user.js';
import pluginsRoutes from './routes/plugins.js';
import leocodeboxRoutes, { startHealthMonitor } from './modules/leocodebox/index.js';
import leophoneRoutes, { startLeophoneRelayClient } from './modules/leophone/index.js';
import { startDailyUsageSummary } from './modules/usage/index.js';
import providerRoutes from './modules/providers/provider.routes.js';
import agentProfilesRoutes from './modules/agent-profiles/agent-profiles.routes.js';
import voiceRoutes from './voice-proxy.js';
import browserUseRoutes from './modules/browser-use/browser-use.routes.js';
import { assetsRoutes } from './modules/assets/index.js';
import { filesRoutes } from './modules/files/index.js';
import tokenUsageRoutes from './modules/usage/token-usage.routes.js';
import usageRoutes from './modules/usage/usage.routes.js';
import browserUseMcpRoutes from './modules/browser-use/browser-use-mcp.routes.js';
import { browserUseService } from './modules/browser-use/browser-use.service.js';
import { startServerLifecycle } from './runtime/server-lifecycle.js';
import { attachWebSocketRuntime } from './runtime/websocket-runtime.js';
import { validateApiKey, authenticateToken, IS_LOCAL_ONLY_AUTH } from './middleware/auth.js';
import { GATEWAY_MOUNT } from './modules/leocodebox/leoapi-gateway/gateway-config.js';
import gatewayProxyRoutes from './modules/leocodebox/leoapi-gateway/gateway.routes.js';
import { createCorsMiddleware } from './middleware/cors-policy.js';

const __dirname = getModuleDir(import.meta.url);
// The server source runs from /server, while the compiled output runs from /dist-server/server.
// Resolving the app root once keeps every repo-level lookup below aligned across both layouts.
const APP_ROOT = findAppRoot(__dirname);
const VITE_PORT = Number.parseInt(process.env.VITE_PORT || '', 10) || 5173;
const installMode = fs.existsSync(path.join(APP_ROOT, '.git')) ? 'git' : 'npm';
// Version of the code that is actually running, captured once at process
// startup. This intentionally does NOT re-read package.json per request: after
// an update replaces the files on disk, package.json reflects the NEW version
// while this long-lived process still runs the OLD code. The frontend bundle is
// rebuilt on update, so a mismatch between this value and the frontend's
// build-time version means the server was updated but not restarted.
const RUNNING_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || null;
    } catch {
        return null;
    }
})();

logger.info('SERVER_PORT from env:', process.env.SERVER_PORT);

const app = express();
const server = http.createServer(app);
attachWebSocketRuntime(server, app);

app.use(createCorsMiddleware());

// Leoapi gateway proxy (opt-in, default off): mounted BEFORE the JSON body
// parser so the agent CLI's request body streams through untouched, and
// OUTSIDE /api so it isn't gated by the app's local-auth (the CLI authenticates
// with an opaque per-node gateway token instead). Loopback-only, self-guarded.
app.use(GATEWAY_MOUNT, gatewayProxyRoutes);

app.use(express.json({
    limit: '50mb',
    type: (req) => {
        // Skip multipart/form-data requests (for file uploads like images)
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return false;
        }
        return contentType.includes('json');
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Public health check endpoint (no authentication required)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        installMode,
        version: RUNNING_VERSION
    });
});

// LeoPhoneAgent harness 面(自带 Bearer 鉴权,与本机 UI token 隔离)。
// 挂两处:/leophone 前缀给 tailscale serve/反代直连;根路径别名给中继透传
// (/harness/*、/v1/*;/health 由上面的公共端点先命中,形状兼容)。
app.use('/leophone', leophoneRoutes);
app.use(leophoneRoutes);

// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectModuleRoutes);

// Chat image asset upload/serving (global ~/.leocodebox/assets store, protected)
app.use('/api/assets', authenticateToken, assetsRoutes);

// Git API Routes (protected)
app.use('/api/git', authenticateToken, gitRoutes);

// Cursor API Routes (protected)
app.use('/api/cursor', authenticateToken, cursorRoutes);

// TaskMaster API Routes (protected)
app.use('/api/taskmaster', authenticateToken, taskmasterRoutes);

// MCP utilities
app.use('/api/mcp-utils', authenticateToken, mcpUtilsRoutes);

// Commands API Routes (protected)
app.use('/api/commands', authenticateToken, commandsRoutes);

// Settings API Routes (protected)
app.use('/api/settings', authenticateToken, settingsRoutes);

app.use('/api/notifications', authenticateToken, notificationRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Plugins API Routes (protected)
app.use('/api/plugins', authenticateToken, pluginsRoutes);

// leocodebox local-only extensions: provider switch, feedback, update checks.
app.use('/api/leocodebox', authenticateToken, leocodeboxRoutes);

// Browser MCP bridge API (local token protected)
app.use('/api/browser-use-mcp', browserUseMcpRoutes);

// Browser API Routes (protected)
app.use('/api/browser-use', authenticateToken, browserUseRoutes);

// Unified provider MCP routes (protected)
app.use('/api/providers', authenticateToken, providerRoutes);
app.use('/api/agent-profiles', authenticateToken, agentProfilesRoutes);

// Agent API Routes (uses API key authentication)
app.use('/api/agent', agentRoutes);

app.use('/api/voice', authenticateToken, voiceRoutes);

// Serve public files (like api-docs.html)
app.use(express.static(path.join(APP_ROOT, 'public')));

// Static files served after API routes
// Add cache control: HTML files should not be cached, but assets can be cached
app.use(express.static(path.join(APP_ROOT, 'dist'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            // Prevent HTML caching to avoid service worker issues after builds
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
            // Cache static assets for 1 year (they have hashed names)
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs

// System update endpoint
app.post('/api/system/update', authenticateToken, async (req, res) => {
    try {
        return res.json({
            success: true,
            localOnly: IS_LOCAL_ONLY_AUTH,
            message: '桌面版更新由应用内更新器管理；可使用 /api/leocodebox/updates/check 检查 leocodebox 最新版本。',
        });
    } catch (error) {
        console.error('System update error:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

app.use('/api', authenticateToken, filesRoutes);


// Chat image uploads moved to POST /api/assets/images (server/modules/assets),
// which stores them in the global ~/.leocodebox/assets folder.

// Get token usage for a specific session. `projectId` is the DB primary key;
// the Claude branch below resolves it to an absolute path via the DB.
app.use('/api/projects', authenticateToken, tokenUsageRoutes);
app.use('/api/usage', authenticateToken, usageRoutes);

// Serve React app for all other routes (excluding static files)
app.get('*', (req, res) => {
    // Skip requests for static assets (files with extensions)
    if (path.extname(req.path)) {
        return res.status(404).send('Not found');
    }

    // Only serve index.html for HTML routes, not for static assets
    // Static assets should already be handled by express.static middleware above
    const indexPath = path.join(APP_ROOT, 'dist', 'index.html');

    // Check if dist/index.html exists (production build available)
    if (fs.existsSync(indexPath)) {
        // Set no-cache headers for HTML to prevent service worker issues
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(indexPath);
    } else {
        // In development, redirect to Vite dev server only if dist doesn't exist
        const redirectHost = getConnectableHost(req.hostname);
        res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
    }
});

// global error middleware must be last
const globalErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  console.error(err);

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
};
app.use(globalErrorHandler);


void browserUseService.repairAgentMcpRegistration().catch((error) => {
    console.warn('[Browser] Failed to repair managed MCP registration:', error instanceof Error ? error.message : error);
});

// Background Leoapi health monitor — same gate as the /switch routes it serves.
if (process.env.LEOCODEBOX_LOCAL_ONLY === '1') {
  startHealthMonitor();
  // 出站注册到 LeoPhoneAgent 自营中继(配置存在时);手机经原路径直达本机。
  startLeophoneRelayClient();
}

startDailyUsageSummary();

void startServerLifecycle({ server, appRoot: APP_ROOT, installMode, runningVersion: RUNNING_VERSION });
