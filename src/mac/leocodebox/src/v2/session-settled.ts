/** agent_end 后面还可能接着排队；真正闲下来是 agent_settled。 */

export function isRunTerminal(event: string | null | undefined): boolean {
  return event === 'run.completed' || event === 'run.failed' || event === 'run.cancelled';
}
