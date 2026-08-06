/**
 * OrcaWorkflowRoute — legacy /cc-agent/orca/:sessionId compatibility route.
 *
 * Worker 面板已迁移到右侧栏「协同」tab。历史 deep link / 通知 / 子窗口仍可能
 * 打到 /orca,这里只负责把它们转到普通 Lead 路由,并把 query 中的 worker hint
 * 翻译成协同 tab state,避免主路由长期带着旧 query。
 */

import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { useCCSessions } from '@/hooks/useCCSessions';
import { useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import { isOrcaLeadSession } from '@/lib/orcaSessionIdentity';
import { mergeSessionSources } from './lib/mergeSessionSources';

export function OrcaWorkflowRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { sessions, isLoading } = useCCSessions();
  const remoteSessions = useRemoteProjectSessions();
  const leadSession = useMemo(() => {
    if (!sessionId) return null;
    return mergeSessionSources(sessions, remoteSessions).find((s) => s.id === sessionId) ?? null;
  }, [sessionId, sessions, remoteSessions]);

  useEffect(() => {
    if (!sessionId || isLoading) return;
    if (!leadSession) {
      navigate('/cc-agent', { replace: true });
      return;
    }
    const params = new URLSearchParams(location.search);
    const rawWorker = params.get('worker');
    const workerSessionId = rawWorker && rawWorker !== 'new' ? rawWorker : null;
    params.delete('worker');
    params.delete('workerAgent');
    const nextSearch = params.toString();
    const previousState =
      location.state && typeof location.state === 'object'
        ? (location.state as Record<string, unknown>)
        : {};
    const orcaWorkersReveal = isOrcaLeadSession(leadSession)
      ? {
          leadSessionId: sessionId,
          focusWorkerSessionId: workerSessionId,
        }
      : undefined;
    navigate(`/cc-agent/${sessionId}${nextSearch ? `?${nextSearch}` : ''}`, {
      replace: true,
      state: {
        ...previousState,
        orcaWorkersReveal,
      },
    });
  }, [isLoading, leadSession, location.search, location.state, navigate, sessionId]);

  return <div className="h-full w-full bg-content-area" />;
}
