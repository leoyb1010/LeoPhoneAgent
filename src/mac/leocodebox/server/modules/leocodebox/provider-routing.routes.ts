import express from 'express';

import { requireLocalOnly } from '../../shared/local-only.js';

import {
  BUILTIN_SLOTS,
  clearRoutingSlot,
  getRoutingSlots,
  setRoutingSlot,
} from './provider-routing.service.js';
import { normalizeTarget, readStore, sanitizeProvider } from './provider-store.service.js';

const router = express.Router();

/** List slot bindings for a target, plus the built-in slot ids and the target's providers. */
router.get('/:target', async (req, res, next) => {
  try {
    const target = normalizeTarget(req.params.target);
    if (!target) { res.status(400).json({ success: false, error: 'Unsupported provider target.' }); return; }
    const [slots, store] = await Promise.all([getRoutingSlots(target), readStore()]);
    res.json({
      success: true,
      target,
      builtinSlots: BUILTIN_SLOTS,
      slots,
      providers: store.providers.filter((p) => p.target === target).map(sanitizeProvider),
    });
  } catch (error) {
    next(error);
  }
});

/** Bind a slot: PUT /:target/:slot { providerId, model? }. */
router.put('/:target/:slot', requireLocalOnly, async (req, res, next) => {
  try {
    const slots = await setRoutingSlot(req.params.target, req.params.slot, {
      providerId: String(req.body?.providerId || ''),
      model: req.body?.model ? String(req.body.model) : undefined,
    });
    res.json({ success: true, slots });
  } catch (error) {
    next(error);
  }
});

/** Clear a slot binding. */
router.delete('/:target/:slot', requireLocalOnly, async (req, res, next) => {
  try {
    const slots = await clearRoutingSlot(req.params.target, req.params.slot);
    res.json({ success: true, slots });
  } catch (error) {
    next(error);
  }
});

export default router;
