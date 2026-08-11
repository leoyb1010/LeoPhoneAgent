import express from 'express';

import fileContentRoutes from './file-content.routes.js';
import fileMutationRoutes from './file-mutation.routes.js';
import fileUploadRoutes from './file-upload.routes.js';
import workspaceFilesystemRoutes from './workspace-filesystem.routes.js';

const router = express.Router();

router.use(workspaceFilesystemRoutes);
router.use(fileContentRoutes);
router.use(fileMutationRoutes);
router.use(fileUploadRoutes);

export default router;
