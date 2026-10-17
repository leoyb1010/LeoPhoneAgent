import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserRecordingArtifact } from "@zcode/shared";

function resolveWorkspaceRecordingPath(workspacePath: string, outputPath: string): string {
  const root = resolve(workspacePath);
  const target = resolve(root, outputPath);
  const relation = relative(root, target);
  if (!relation || relation.startsWith("..") || resolve(root, relation) !== target) {
    throw new Error("recording outputPath must stay inside the workspace");
  }
  if (!target.toLowerCase().endsWith(".webm")) {
    throw new Error("recording outputPath must end with .webm");
  }
  return target;
}

/**
 * main 只返回短期 WebM；Host 在本地 workspace 内落盘（同目录 staging + rename）。
 * 远程工作区已删除：带 remoteSessionId 的请求直接拒绝，不能落到本机路径。
 */
export async function materializeBrowserRecordingArtifact(input: {
  artifact: BrowserRecordingArtifact;
  localPath: string;
  outputPath: string;
  workspacePath: string;
  remoteSessionId?: string;
}): Promise<BrowserRecordingArtifact> {
  if (input.remoteSessionId) {
    throw new Error("remote Browser recording materialization is unavailable for this session");
  }

  const targetPath = resolveWorkspaceRecordingPath(input.workspacePath, input.outputPath);
  await mkdir(dirname(targetPath), { recursive: true });
  const stagingPath = `${targetPath}.zcode-recording-${randomUUID()}.tmp`;
  try {
    await copyFile(input.localPath, stagingPath);
    // Windows 不能用 rename 原子覆盖已有文件；先移除明确的目标 WebM，再提交 staging 文件。
    await rm(targetPath, { force: true });
    await rename(stagingPath, targetPath);
  } finally {
    await rm(stagingPath, { force: true }).catch(() => undefined);
  }
  return { ...input.artifact, path: targetPath };
}
