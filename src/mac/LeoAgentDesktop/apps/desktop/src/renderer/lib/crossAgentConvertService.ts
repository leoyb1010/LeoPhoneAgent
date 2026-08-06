/**
 * crossAgentConvertService — renderer 侧 IPC 薄层。
 *
 * 仅命令转发，不持有状态。
 */

export const crossAgentConvertService = {
  detect(workingDir: string, agentKind: 'claude-code' | 'codex'): Promise<{ items: CrossAgentMigrationItem[] }> {
    return window.electronAPI.maker.crossAgent.detect(workingDir, agentKind);
  },
  convert(items: CrossAgentMigrationItem[]): Promise<{
    total: number;
    successCount: number;
    skippedCount: number;
    failedCount: number;
  }> {
    return window.electronAPI.maker.crossAgent.convert(items);
  },
  /** 订阅每步进度事件，返回 unsubscribe。 */
  onStep(cb: (ev: CrossAgentStepEvent) => void): () => void {
    return window.electronAPI.maker.crossAgent.onStep(cb);
  },
};
