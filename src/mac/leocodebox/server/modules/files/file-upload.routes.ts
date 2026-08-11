import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import multer from 'multer';

import { projectsDb } from '@/modules/database/index.js';
import { assertRealPathWithinRoot, validatePathInProject } from '@/modules/files/files.service.js';

const router = express.Router();
const MAX_FILE_UPLOAD_SIZE_MB = 200;
const MAX_FILE_UPLOAD_SIZE_BYTES = MAX_FILE_UPLOAD_SIZE_MB * 1024 * 1024;
const MAX_FILE_UPLOAD_COUNT = 20;

const uploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, os.tmpdir()),
    filename: (_req, _file, callback) => {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      callback(null, `upload-${uniqueSuffix}`);
    },
  }),
  limits: {
    fileSize: MAX_FILE_UPLOAD_SIZE_BYTES,
    files: MAX_FILE_UPLOAD_COUNT,
  },
});

const receiveUpload: RequestHandler = (req, res, next) => {
  uploadMiddleware.array('files', MAX_FILE_UPLOAD_COUNT)(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    const multerError = error as Error & { code?: string };
    console.error('Multer error:', multerError);
    if (multerError.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ error: `File too large. Maximum size is ${MAX_FILE_UPLOAD_SIZE_MB}MB.` });
      return;
    }
    if (multerError.code === 'LIMIT_FILE_COUNT') {
      res.status(400).json({ error: `Too many files. Maximum is ${MAX_FILE_UPLOAD_COUNT} files.` });
      return;
    }
    res.status(500).json({ error: multerError.message });
  });
};

function parseRelativePaths(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function toNodeError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error as NodeJS.ErrnoException : new Error(String(error));
}

async function removeTemporaryFiles(files: Express.Multer.File[]): Promise<void> {
  await Promise.all(files.map((file) => fsPromises.unlink(file.path).catch(() => undefined)));
}

router.post(
  '/projects/:projectId/files/upload',
  receiveUpload,
  async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    try {
      if (files.length === 0) return res.status(400).json({ error: 'No files provided' });

      const relativePaths = parseRelativePaths(req.body?.relativePaths);
      const requestedFileCountRaw = typeof req.body?.requestedFileCount === 'string'
        ? req.body.requestedFileCount
        : '';
      const parsedRequestedFileCount = Number.parseInt(requestedFileCountRaw, 10);
      const requestedFileCount = Number.isFinite(parsedRequestedFileCount) && parsedRequestedFileCount > 0
        ? parsedRequestedFileCount
        : files.length;

      const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
      const projectRoot = await projectsDb.getProjectPathById(projectId || '');
      if (!projectRoot) {
        await removeTemporaryFiles(files);
        return res.status(404).json({ error: 'Project not found' });
      }

      const targetPath = typeof req.body?.targetPath === 'string' ? req.body.targetPath : '';
      let resolvedTargetDir = path.resolve(projectRoot);
      if (targetPath && targetPath !== '.' && targetPath !== './') {
        const validation = validatePathInProject(projectRoot, targetPath);
        if (!validation.valid || !validation.resolved) {
          await removeTemporaryFiles(files);
          return res.status(403).json({ error: validation.error || 'Invalid upload path' });
        }
        const targetRealCheck = await assertRealPathWithinRoot(projectRoot, validation.resolved, { allowMissing: true });
        if (!targetRealCheck.valid || !targetRealCheck.realPath) {
          await removeTemporaryFiles(files);
          return res.status(403).json({ error: targetRealCheck.error || 'Invalid upload path' });
        }
        resolvedTargetDir = targetRealCheck.realPath;
      }

      await fsPromises.mkdir(resolvedTargetDir, { recursive: true });
      const uploadedFiles: Array<{ name: string; path: string; size: number; mimeType: string }> = [];

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const fileName = relativePaths[index] || file.originalname;
        const destPath = path.join(resolvedTargetDir, fileName);
        const destValidation = validatePathInProject(projectRoot, destPath);
        if (!destValidation.valid || !destValidation.resolved) {
          await fsPromises.unlink(file.path).catch(() => undefined);
          continue;
        }

        const destRealCheck = await assertRealPathWithinRoot(projectRoot, destValidation.resolved, { allowMissing: true });
        if (!destRealCheck.valid || !destRealCheck.realPath) {
          await fsPromises.unlink(file.path).catch(() => undefined);
          continue;
        }

        const safeDestPath = destRealCheck.realPath;
        await fsPromises.mkdir(path.dirname(safeDestPath), { recursive: true });
        await fsPromises.copyFile(file.path, safeDestPath);
        await fsPromises.unlink(file.path);
        uploadedFiles.push({
          name: fileName,
          path: safeDestPath,
          size: file.size,
          mimeType: file.mimetype,
        });
      }

      return res.json({
        success: true,
        files: uploadedFiles,
        uploadedCount: uploadedFiles.length,
        requestedFileCount,
        targetPath: resolvedTargetDir,
        message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`,
      });
    } catch (error) {
      const nodeError = toNodeError(error);
      console.error('Error uploading files:', error);
      await removeTemporaryFiles(files);
      if (nodeError.code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
      return res.status(500).json({ error: nodeError.message });
    }
  },
);

export default router;
