/**
 * Authed control/status surface for the Leoapi gateway (under /api/leocodebox/
 * gateway). Separate from the loopback proxy surface: this one is the app UI's
 * toggle + live wire-meter readout.
 */
import express from 'express';

import { gatewayBaseUrl, isCompactionEnabled, isGatewayEnabled, setCompactionEnabled, setGatewayEnabled } from './gateway-config.js';
import { compactionSnapshot } from './gateway-compaction.js';
import { gatewayMeterSnapshot } from './gateway-meter.js';

const router = express.Router();

router.get('/status', (_req, res) => {
  res.json({
    success: true,
    enabled: isGatewayEnabled(),
    compaction: isCompactionEnabled(),
    baseUrl: gatewayBaseUrl(),
    meter: gatewayMeterSnapshot(),
    compactionMeter: compactionSnapshot(),
  });
});

router.put('/toggle', (req, res) => {
  const enabled = setGatewayEnabled(Boolean(req.body?.enabled));
  res.json({ success: true, enabled });
});

router.put('/compaction', (req, res) => {
  const compaction = setCompactionEnabled(Boolean(req.body?.enabled));
  res.json({ success: true, compaction });
});

export default router;
