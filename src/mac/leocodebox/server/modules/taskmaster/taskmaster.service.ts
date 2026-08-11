import spawn from 'cross-spawn';

import { projectsDb } from '../database/index.js';

export type TaskMasterInstallationStatus = {
  isInstalled: boolean;
  installPath: string | null;
  version: string | null;
  reason: string | null;
};

export async function resolveProjectPathFromId(projectId: string): Promise<string | null> {
  if (!projectId) return null;
  return projectsDb.getProjectPathById(projectId);
}

export async function checkTaskMasterInstallation(): Promise<TaskMasterInstallationStatus> {
  return new Promise((resolve) => {
    const child = spawn('which', ['task-master'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (data: Buffer) => { output += data.toString(); });

    child.on('close', (code) => {
      if (code !== 0 || !output.trim()) {
        resolve({ isInstalled: false, installPath: null, version: null, reason: 'TaskMaster CLI not found in PATH' });
        return;
      }

      const versionChild = spawn('task-master', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let versionOutput = '';
      versionChild.stdout?.on('data', (data: Buffer) => { versionOutput += data.toString(); });
      versionChild.on('close', (versionCode) => {
        resolve({
          isInstalled: true,
          installPath: output.trim(),
          version: versionCode === 0 ? versionOutput.trim() : 'unknown',
          reason: null,
        });
      });
      versionChild.on('error', () => {
        resolve({ isInstalled: true, installPath: output.trim(), version: 'unknown', reason: null });
      });
    });

    child.on('error', (error) => {
      resolve({ isInstalled: false, installPath: null, version: null, reason: `Error checking installation: ${error.message}` });
    });
  });
}
