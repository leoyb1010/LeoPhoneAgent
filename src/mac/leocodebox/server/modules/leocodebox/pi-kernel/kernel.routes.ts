/**
 * Authed run surface for the pi kernel v0 (under /api/leocodebox/kernel).
 * POST /run executes one read-only agent task against the active claude node.
 * Read-only + path-sandboxed + step-capped, so a single authed local call
 * cannot write, execute, or read outside the chosen root.
 */
import { statSync } from 'node:fs';
import path from 'node:path';

import express from 'express';

import { createAnthropicCallModel, resolveActiveClaudeModel } from './kernel-client.js';
import { createKernelTools, type KernelCapabilities } from './kernel-tools.js';
import { runKernelTask } from './kernel.js';

const router = express.Router();

const MAX_PROMPT = 8000;

function systemPrompt(root: string, caps: KernelCapabilities): string {
  const tools = ['read_file(读取根目录内文本文件)', 'list_dir(列目录)'];
  if (caps.allowWrite) tools.push('write_file(在根目录内创建/覆盖文件)');
  if (caps.allowExec) tools.push('run_shell(在根目录内执行命令,有超时与输出上限)');
  return [
    caps.allowWrite || caps.allowExec ? '你是 leocodebox 的自有内核(代码助手)。' : '你是 leocodebox 的自有内核(只读代码助手)。',
    `工作根目录是:${root}`,
    `你有这些工具:${tools.join('、')}。`,
    '只能访问根目录内的路径。请先用工具查证,再用简洁的中文作答;不要臆测未读到的内容。',
    caps.allowWrite || caps.allowExec ? '涉及修改文件或执行命令时,先说明你要做什么,再动手,保持最小改动。' : '',
  ].filter(Boolean).join('\n');
}

router.post('/run', async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt) {
    res.status(400).json({ success: false, error: 'prompt is required' });
    return;
  }
  if (prompt.length > MAX_PROMPT) {
    res.status(400).json({ success: false, error: `prompt too long (max ${MAX_PROMPT})` });
    return;
  }

  const root = path.resolve(typeof req.body?.root === 'string' && req.body.root ? req.body.root : process.cwd());
  try {
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    res.status(400).json({ success: false, error: `root is not an existing directory: ${root}` });
    return;
  }

  const active = await resolveActiveClaudeModel();
  if (!active) {
    res.status(409).json({ success: false, error: '没有可用的 active claude 节点(请先在 Leoapi 里配置并激活一个节点)。' });
    return;
  }

  const caps: KernelCapabilities = { allowWrite: req.body?.allowWrite === true, allowExec: req.body?.allowExec === true };
  const { specs, execute } = createKernelTools(root, caps);
  const callModel = createAnthropicCallModel({
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: active.model,
    system: systemPrompt(root, caps),
    tools: specs,
  });

  const maxSteps = Number.isInteger(req.body?.maxSteps) ? Math.max(1, Math.min(20, req.body.maxSteps)) : undefined;
  try {
    const run = await runKernelTask({ prompt, tools: specs, callModel, executeTool: execute, maxSteps });
    res.json({
      success: true,
      provider: active.providerName,
      model: active.model,
      root,
      capabilities: caps,
      finalText: run.finalText,
      steps: run.steps,
      aborted: run.aborted,
      events: run.events,
    });
  } catch (error) {
    res.status(502).json({ success: false, error: error instanceof Error ? error.message : 'kernel run failed' });
  }
});

export default router;
