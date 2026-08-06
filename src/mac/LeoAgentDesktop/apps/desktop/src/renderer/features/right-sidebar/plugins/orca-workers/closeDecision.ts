import type { OrcaRole } from '@/lib/ccAgent.types';
import { isOrcaLeadSession } from '@/lib/orcaSessionIdentity';

export type OrcaWorkersCloseDecision = 'veto' | 'close' | 'stop-team';

export function getOrcaWorkersCloseDecision({
  isLoading,
  leadSession,
}: {
  isLoading: boolean;
  leadSession: { orcaRole?: OrcaRole | null } | null;
}): OrcaWorkersCloseDecision {
  if (isLoading || !leadSession) return 'veto';
  return isOrcaLeadSession(leadSession) ? 'stop-team' : 'close';
}
