import { timingSafeEqual } from 'node:crypto';

import express from 'express';

import { executeTreasuryTool, TreasuryToolError, treasuryMcpService } from './treasury-mcp.service.js';

const router = express.Router();

function tokenMatches(actual: string, expected: string): boolean {
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

router.use((req, res, next) => {
  const expected = treasuryMcpService.getMcpToken();
  const match = /^Bearer\s+(\S.*)$/i.exec(String(req.headers.authorization || '').trim());
  const actual = match?.[1]?.trim() || '';
  if (!actual || !tokenMatches(actual, expected)) {
    res.status(401).json({ success: false, error: 'Invalid Treasury MCP token.' }); return;
  }
  next();
});

router.post('/tools/:toolName', (req, res) => {
  try {
    const input = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const data = executeTreasuryTool(treasuryMcpService.localUserId(), req.params.toolName, input);
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ success: false, error: error instanceof TreasuryToolError
      ? error.message : 'Treasury operation failed.' });
  }
});

export default router;
