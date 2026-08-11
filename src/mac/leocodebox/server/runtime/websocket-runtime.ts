import type { Server as HttpServer } from 'node:http';

import type { Express } from 'express';

import {
  abortClaudeSDKSession,
  getPendingApprovalsForSession,
  queryClaudeSDK,
  resolveToolApproval,
} from '@/modules/providers/list/claude/claude-runtime.js';
import { abortCodexSession, queryCodex } from '@/modules/providers/list/codex/codex-runtime.js';
import { abortCursorSession, spawnCursor } from '@/modules/providers/list/cursor/cursor-runtime.js';
import { abortGrokSession, spawnGrok } from '@/modules/providers/list/grok/grok-runtime.js';
import { abortOpenCodeSession, spawnOpenCode } from '@/modules/providers/list/opencode/opencode-runtime.js';
import { createWebSocketServer } from '@/modules/websocket/index.js';
import { sessionsDb } from '@/modules/database/index.js';

import { IS_PLATFORM } from '../constants/config.js';
import { authenticateWebSocket, IS_LOCAL_ONLY_AUTH } from '../middleware/auth.js';
import { getPluginPort } from '../utils/plugin-process-manager.js';
import {
  extractUrlsFromText,
  normalizeDetectedUrl,
  shouldAutoOpenUrlFromOutput,
  stripAnsiSequences,
} from '../utils/url-detection.js';

export function attachWebSocketRuntime(server: HttpServer, app: Express) {
  const wss = createWebSocketServer(server, {
    verifyClient: {
      isPlatform: IS_PLATFORM,
      isLocalOnly: IS_LOCAL_ONLY_AUTH,
      authenticateWebSocket,
    },
    chat: {
      spawnFns: {
        claude: queryClaudeSDK,
        cursor: spawnCursor,
        codex: queryCodex,
        opencode: spawnOpenCode,
        grok: spawnGrok,
      },
      abortFns: {
        claude: abortClaudeSDKSession,
        cursor: abortCursorSession,
        codex: abortCodexSession,
        opencode: abortOpenCodeSession,
        grok: abortGrokSession,
      },
      resolveToolApproval,
      getPendingApprovalsForSession,
    },
    shell: {
      resolveProviderSessionId: (sessionId: string) => sessionsDb.getSessionById(sessionId)?.provider_session_id ?? null,
      stripAnsiSequences,
      normalizeDetectedUrl,
      extractUrlsFromText,
      shouldAutoOpenUrlFromOutput,
    },
    getPluginPort,
  });
  app.locals.wss = wss;
  return wss;
}
