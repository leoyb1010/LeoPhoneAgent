import express from 'express';

import actionsRoutes from './taskmaster-actions.routes.js';
import parseRoutes from './taskmaster-parse.routes.js';
import prdRoutes from './taskmaster-prd.routes.js';
import statusRoutes from './taskmaster-status.routes.js';
import templateRoutes from './taskmaster-template.routes.js';
import updateRoutes from './taskmaster-update.routes.js';

const router = express.Router();

router.use(statusRoutes);
router.use(prdRoutes);
router.use(actionsRoutes);
router.use(updateRoutes);
router.use(parseRoutes);
router.use(templateRoutes);

export default router;
