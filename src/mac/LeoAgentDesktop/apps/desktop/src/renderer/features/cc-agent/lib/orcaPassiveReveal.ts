export interface OrcaPassiveRevealDecisionInput {
  collabEnabled: boolean;
  ownsRoute: boolean;
  isCompactRail: boolean;
  hasExplicitReveal: boolean;
  collapsedRecord: boolean | null;
}

export interface OrcaFirstFrameRevealDecisionInput extends OrcaPassiveRevealDecisionInput {
  hasSynchronousSessionIdentity: boolean;
}

function canPassivelyRevealOrcaWorkers(
  input: OrcaPassiveRevealDecisionInput,
): boolean {
  return (
    input.collabEnabled &&
    input.ownsRoute &&
    !input.isCompactRail &&
    !input.hasExplicitReveal &&
    input.collapsedRecord === null
  );
}

/**
 * 点击左栏切入已在会话列表缓存里的 Orca Lead 时,首帧即可同步知道身份和
 * collapsed 三态。只有这个路径可以在 paint 前把右侧栏直接摆到展开态。
 */
export function shouldRevealOrcaWorkersBeforeFirstPaint(
  input: OrcaFirstFrameRevealDecisionInput,
): boolean {
  return input.hasSynchronousSessionIdentity && canPassivelyRevealOrcaWorkers(input);
}

/**
 * 异步才知道身份的路径仍需要 effect 兜底 reveal,但应走默认动画来避免突然挤压。
 */
export function shouldRevealOrcaWorkersAfterPaint(
  input: OrcaPassiveRevealDecisionInput,
): boolean {
  return canPassivelyRevealOrcaWorkers(input);
}
