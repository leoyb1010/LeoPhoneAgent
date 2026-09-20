export const LIVE_TOOL_MAX = 2000;

/** 跑着的命令只留尾巴，长测才看得到最后几行。 */
export function clipLiveToolOutput(text?: string | null): string {
  const clean = String(text ?? '').replace(/\u0000/g, '');
  if (!clean) return '';
  return clean.length > LIVE_TOOL_MAX ? clean.slice(-LIVE_TOOL_MAX) : clean;
}

export function shouldOpenLiveTool(running?: boolean, output?: string | null): boolean {
  return Boolean(running && String(output ?? '').trim());
}
