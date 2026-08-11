import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import express from 'express';

import { detectTaskMasterMCPServer } from '../../utils/mcp-detector.js';

import { checkTaskMasterInstallation, resolveProjectPathFromId } from './taskmaster.service.js';

const router = express.Router();
type AnyRecord = Record<string, any>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

router.get('/installation-status', async (_req, res) => {
  try {
    const installationStatus = await checkTaskMasterInstallation();
    const mcpStatus = await detectTaskMasterMCPServer() as { hasMCPServer?: boolean; [key: string]: unknown };
    return res.json({
      success: true,
      installation: installationStatus,
      mcpServer: mcpStatus,
      isReady: installationStatus.isInstalled && mcpStatus.hasMCPServer,
    });
  } catch (error) {
    const message = errorMessage(error);
    console.error('Error checking TaskMaster installation:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to check TaskMaster installation status',
      installation: { isInstalled: false, reason: `Server error: ${message}` },
      mcpServer: { hasMCPServer: false, reason: `Server error: ${message}` },
      isReady: false,
    });
  }
});

router.get('/tasks/:projectId', async (req, res) => {
  try {
    const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
    const projectPath = await resolveProjectPathFromId(projectId || '');
    if (!projectPath) return res.status(404).json({ error: 'Project not found', message: `Project "${projectId}" does not exist` });

    const tasksFilePath = path.join(projectPath, '.taskmaster', 'tasks', 'tasks.json');
    try {
      await fsPromises.access(tasksFilePath);
    } catch {
      return res.json({ projectId, tasks: [], message: 'No tasks.json file found' });
    }

    try {
      const tasksData = JSON.parse(await fsPromises.readFile(tasksFilePath, 'utf8')) as AnyRecord | AnyRecord[];
      let tasks: AnyRecord[] = [];
      let currentTag = 'master';
      if (Array.isArray(tasksData)) {
        tasks = tasksData;
      } else if (Array.isArray(tasksData.tasks)) {
        tasks = tasksData.tasks;
      } else {
        const tagged = tasksData[currentTag]?.tasks || tasksData.master?.tasks;
        if (Array.isArray(tagged)) {
          tasks = tagged;
        } else {
          const firstTag = Object.keys(tasksData).find((key) => Array.isArray(tasksData[key]?.tasks));
          if (firstTag) {
            tasks = tasksData[firstTag].tasks;
            currentTag = firstTag;
          }
        }
      }

      const transformedTasks = tasks.map((task) => ({
        id: task.id,
        title: task.title || 'Untitled Task',
        description: task.description || '',
        status: task.status || 'pending',
        priority: task.priority || 'medium',
        dependencies: task.dependencies || [],
        createdAt: task.createdAt || task.created || new Date().toISOString(),
        updatedAt: task.updatedAt || task.updated || new Date().toISOString(),
        details: task.details || '',
        testStrategy: task.testStrategy || task.test_strategy || '',
        subtasks: task.subtasks || [],
      }));

      return res.json({
        projectId,
        projectPath,
        tasks: transformedTasks,
        currentTag,
        totalTasks: transformedTasks.length,
        tasksByStatus: {
          pending: transformedTasks.filter((task) => task.status === 'pending').length,
          'in-progress': transformedTasks.filter((task) => task.status === 'in-progress').length,
          done: transformedTasks.filter((task) => task.status === 'done').length,
          review: transformedTasks.filter((task) => task.status === 'review').length,
          deferred: transformedTasks.filter((task) => task.status === 'deferred').length,
          cancelled: transformedTasks.filter((task) => task.status === 'cancelled').length,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Failed to parse tasks.json:', error);
      return res.status(500).json({ error: 'Failed to parse tasks file', message: errorMessage(error) });
    }
  } catch (error) {
    console.error('TaskMaster tasks loading error:', error);
    return res.status(500).json({ error: 'Failed to load TaskMaster tasks', message: errorMessage(error) });
  }
});

export default router;
