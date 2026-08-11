import express from 'express';

import { broadcastTaskMasterTasksUpdate } from '../../utils/taskmaster-websocket.js';

import { runTaskMasterCommand } from './taskmaster-cli.service.js';
import { resolveProjectPathFromId } from './taskmaster.service.js';

const router = express.Router();

function readParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

router.put('/update-task/:projectId/:taskId', async (req, res) => {
  try {
    const projectId = readParam(req.params.projectId);
    const taskId = readParam(req.params.taskId);
    const status = typeof req.body?.status === 'string' ? req.body.status : '';
    const projectPath = await resolveProjectPathFromId(projectId);
    if (!projectPath) return res.status(404).json({ error: 'Project not found', message: `Project "${projectId}" does not exist` });

    let args: string[];
    let successMessage: string;
    let failureMessage: string;
    if (status && Object.keys(req.body || {}).length === 1) {
      args = ['task-master-ai', 'set-status', `--id=${taskId}`, `--status=${status}`];
      successMessage = 'Task status updated successfully';
      failureMessage = 'Failed to update task status';
    } else {
      const updates: string[] = [];
      for (const key of ['title', 'description', 'priority', 'details'] as const) {
        const value = req.body?.[key];
        if (typeof value === 'string' && value.trim()) updates.push(`${key}: "${value}"`);
      }
      if (updates.length === 0) return res.status(400).json({ error: 'No supported task updates were provided' });
      args = ['task-master-ai', 'update-task', `--id=${taskId}`, `--prompt=Update task with the following changes: ${updates.join(', ')}`];
      successMessage = 'Task updated successfully';
      failureMessage = 'Failed to update task';
    }

    const result = await runTaskMasterCommand(projectPath, args);
    if (result.code !== 0) {
      console.error(`${failureMessage}:`, result.stderr);
      return res.status(500).json({ error: failureMessage, message: result.stderr || result.stdout, code: result.code });
    }

    if (req.app.locals.wss) broadcastTaskMasterTasksUpdate(req.app.locals.wss, projectId, { source: 'update-task', taskId });
    return res.json({ projectId, projectPath, taskId, message: successMessage, output: result.stdout, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Update task error:', error);
    return res.status(500).json({ error: 'Failed to update task', message: errorMessage(error) });
  }
});

export default router;
