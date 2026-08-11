import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cpu, CornerDownLeft, Loader2 } from 'lucide-react';

import { apiClient } from '../../../utils/apiClient';

import { DashCard, DashCardTitle } from './dashShared';

type KernelEvent = { type: string; name?: string };
type KernelResult = {
  success: boolean;
  provider?: string;
  model?: string;
  finalText?: string;
  steps?: number;
  aborted?: boolean;
  events?: KernelEvent[];
};

/**
 * pi 自有内核 v0 — a calm, one-shot runner. Give it a project root and a
 * question; the read-only agent loop reads files and answers. Deliberately
 * simple: two fields, one button, an answer + a compact tool trace.
 */
export default function KernelCard({ delay = 0 }: { delay?: number }) {
  const { t } = useTranslation();
  const [root, setRoot] = useState('');
  const [prompt, setPrompt] = useState('');
  const [allowWrite, setAllowWrite] = useState(false);
  const [allowExec, setAllowExec] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<KernelResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    const trimmedPrompt = prompt.trim();
    const trimmedRoot = root.trim();
    if (!trimmedPrompt || !trimmedRoot || running) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const data = await apiClient.post<KernelResult>('/api/leocodebox/kernel/run', { prompt: trimmedPrompt, root: trimmedRoot, allowWrite, allowExec });
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '内核运行失败');
    } finally {
      setRunning(false);
    }
  }, [prompt, root, allowWrite, allowExec, running]);

  const toolCalls = (result?.events ?? []).filter((event) => event.type === 'tool_call');
  const canRun = Boolean(prompt.trim() && root.trim()) && !running;

  return (
    <DashCard delay={delay} className="p-4">
      <DashCardTitle
        title={
          <span className="inline-flex items-center gap-2">
            <Cpu className="h-4 w-4 text-primary" />
            {t('dashboard.kernelTitle', { defaultValue: '自有内核' })}
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">beta</span>
          </span>
        }
      />

      <div className="flex flex-col gap-2">
        <input
          value={root}
          onChange={(event) => setRoot(event.target.value)}
          placeholder={t('dashboard.kernelRoot', { defaultValue: '项目根目录,如 /Users/you/code/app' })}
          spellCheck={false}
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none transition-colors focus:border-primary"
        />
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void run(); }}
          placeholder={t('dashboard.kernelPrompt', { defaultValue: '问代码库一个问题,内核会读文件后作答(⌘↵ 运行)' })}
          rows={2}
          className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] text-foreground outline-none transition-colors focus:border-primary"
        />
        <div className="flex items-center gap-3">
          {/* Opt-in capabilities — both default OFF; read-only otherwise. */}
          <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={allowWrite} onChange={(event) => setAllowWrite(event.target.checked)} className="h-3 w-3 accent-primary" />
            {t('dashboard.kernelAllowWrite', { defaultValue: '允许写文件' })}
          </label>
          <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={allowExec} onChange={(event) => setAllowExec(event.target.checked)} className="h-3 w-3 accent-primary" />
            {t('dashboard.kernelAllowExec', { defaultValue: '允许执行命令' })}
          </label>
          <button
            type="button"
            disabled={!canRun}
            onClick={() => void run()}
            className="ml-auto inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-transform hover:scale-[1.02] disabled:opacity-40 disabled:hover:scale-100"
          >
            {running
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('dashboard.kernelRunning', { defaultValue: '运行中' })}</>
              : <>{t('dashboard.kernelRun', { defaultValue: '运行' })}<CornerDownLeft className="h-3.5 w-3.5" /></>}
          </button>
        </div>
        {(allowWrite || allowExec) && (
          <p className="text-[10px] leading-relaxed text-warning">
            {t('dashboard.kernelCapWarn', { defaultValue: '已开启写/执行:内核会在根目录内修改文件或运行命令(有沙箱/超时,仍请在可回滚的目录使用)。' })}
          </p>
        )}
      </div>

      {error && (
        <p className="mt-3 rounded-md border border-warning/40 bg-warning/5 px-2.5 py-2 text-[11px] leading-relaxed text-warning">{error}</p>
      )}

      {result?.success && (
        <div className="mt-3 border-t border-border pt-2">
          {toolCalls.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {toolCalls.slice(0, 8).map((call, index) => (
                <span key={index} className="rounded-md bg-secondary/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{call.name}</span>
              ))}
              <span className="ml-auto text-[10px] text-muted-foreground">
                {t('dashboard.kernelSteps', { defaultValue: '{{n}} 步', n: result.steps ?? 0 })}{result.aborted ? ' · 已达上限' : ''}
              </span>
            </div>
          )}
          <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-foreground">{result.finalText || '(无输出)'}</p>
          {result.provider && (
            <p className="mt-1.5 text-[10px] text-muted-foreground">{result.provider} · {result.model}</p>
          )}
        </div>
      )}
    </DashCard>
  );
}
