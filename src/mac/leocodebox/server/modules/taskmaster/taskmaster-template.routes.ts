import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import express from 'express';

import { resolveProjectPathFromId } from './taskmaster.service.js';
import { getAvailableTemplates } from './taskmaster-templates.service.js';

const router = express.Router();

router.get('/prd-templates', (_req, res) => {
  try {
    return res.json({ templates: getAvailableTemplates(), timestamp: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('PRD templates error:', error);
    return res.status(500).json({ error: 'Failed to get PRD templates', message });
  }
});

router.post('/apply-template/:projectId', async (req, res) => {
  try {
    const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
    const templateId = typeof req.body?.templateId === 'string' ? req.body.templateId : '';
    const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName : 'prd.txt';
    const customizations = req.body?.customizations && typeof req.body.customizations === 'object'
      ? req.body.customizations as Record<string, unknown>
      : {};
    if (!templateId) return res.status(400).json({ error: 'Missing required parameter', message: 'templateId is required' });

    const projectPath = await resolveProjectPathFromId(projectId || '');
    if (!projectPath) {
      return res.status(404).json({ error: 'Project not found', message: `Project "${projectId}" does not exist` });
    }

    const template = getAvailableTemplates().find((candidate) => candidate.id === templateId);
    if (!template) return res.status(404).json({ error: 'Template not found', message: `Template "${templateId}" does not exist` });

    let content = template.content;
    for (const [key, value] of Object.entries(customizations)) {
      const placeholder = `[${key}]`;
      content = content.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), String(value));
    }

    const docsDir = path.join(projectPath, '.taskmaster', 'docs');
    await fsPromises.mkdir(docsDir, { recursive: true });
    const filePath = path.join(docsDir, fileName);
    await fsPromises.writeFile(filePath, content, 'utf8');
    return res.json({ projectId, projectPath, templateId, templateName: template.name, fileName, filePath, message: 'PRD template applied successfully', timestamp: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Apply template error:', error);
    return res.status(500).json({ error: 'Failed to apply PRD template', message });
  }
});

export default router;
