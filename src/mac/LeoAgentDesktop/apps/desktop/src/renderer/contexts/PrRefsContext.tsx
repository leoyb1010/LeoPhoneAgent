/**
 * PrRefsContext — sidebar 会话列表的 PR 引用 / 状态共享缓存(session-git-pr-context)。
 *
 * 设计对标 WorktreeContext:provider 挂 App 顶层,mount 时一次 listAllPrRefs
 * 拉全表建 sessionId → refs 映射(只有出现过 PR 链接的会话才有行,体量小),
 * 之后靠 git-context:pr-refs-changed 推送对单个 session 增量刷新。
 * SessionItem 据此零 IPC 判断"这行有没有 PR"——没有的行不挂任何浮层。
 *
 * **刻意拆成两个 context**:refs(每个 SessionItem 都订阅)与 statuses
 * (只有打开中的 tooltip 订阅)。状态在每次 tip 打开时按需拉取并 setState,
 * 若合在一个 value 里,每次 hover 拉到状态都会让整个侧边栏的所有行重渲染;
 * 拆开后状态更新只触达正在显示的 tip(code-review 性能反馈)。
 *
 * PR 状态(open/merged/...)是远端易变数据,不在启动期预取;main 侧本就有
 * 60s TTL + in-flight 去重,这里只做轻量去重,不再加 TTL。
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { PrStatusResult, SessionPrRef } from '@/lib/gitContext.types';
import { prStatusKey, MAX_STATUS_QUERIES } from '@/hooks/useSessionGitContext';
import { useAuth } from '@/contexts/AuthContext';
import { createLogger } from '@/lib/logger';

const log = createLogger('PrRefsContext');

/** sessionId → PR 引用(lastSeenAt 降序)。无 PR 的会话不在 map 里。 */
const PrRefsMapContext = createContext<Map<string, SessionPrRef[]>>(new Map());

interface PrStatusesContextValue {
  /** prStatusKey(ref) → 状态查询结果。 */
  statuses: Map<string, PrStatusResult>;
  /** tip 打开时按需拉该会话前几条 PR 的状态(共享缓存,重复调用便宜)。 */
  fetchStatusesForSession: (sessionId: string) => void;
}

const PrStatusesContext = createContext<PrStatusesContextValue>({
  statuses: new Map(),
  fetchStatusesForSession: () => undefined,
});

function groupBySession(rows: SessionPrRef[]): Map<string, SessionPrRef[]> {
  const map = new Map<string, SessionPrRef[]>();
  for (const row of rows) {
    const list = map.get(row.sessionId);
    if (list) list.push(row);
    else map.set(row.sessionId, [row]);
  }
  return map; // listAllPrRefs 已按 lastSeenAt 降序,组内顺序天然正确
}

export function PrRefsProvider({ children }: { children: ReactNode }) {
  // 同进程切换 data owner → 另一份本地 db。云账号和本地模式都以 owner id
  // 为 key 重跑，先清旧缓存，再从新 owner 的库重新全量加载。
  const { dataOwnerId } = useAuth();
  const [refsBySession, setRefsBySession] = useState<Map<string, SessionPrRef[]>>(new Map());
  const [statuses, setStatuses] = useState<Map<string, PrStatusResult>>(new Map());
  // fetchStatusesForSession 经 ref 读最新 refs,保持回调身份稳定
  // (依赖 refsBySession 会让每次 refs 更新都重建回调、连带 tooltip 重渲染)。
  const refsRef = useRef(refsBySession);
  refsRef.current = refsBySession;
  // tip 快速划过多行时防止同一会话重复在飞;main 侧有 60s 缓存,这里不做 TTL。
  const inFlightSessions = useRef(new Set<string>());

  useEffect(() => {
    // owner 切换边界:先清掉上一 owner 的缓存,无 owner 时保持空、不发 IPC。
    setRefsBySession(new Map());
    setStatuses(new Map());
    if (dataOwnerId === null) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Provider 挂 App 顶层,首次加载通常早于登录后的 db ensureReady——
    // main 返回 null(未就绪)或抛错时定时重试,直到拿到数据为止。
    const RETRY_MS = 2_000;
    const scheduleRetry = () => {
      if (cancelled) return;
      retryTimer = setTimeout(() => void load(), RETRY_MS);
    };
    const load = async () => {
      try {
        const rows = await window.electronAPI.gitContext.listAllPrRefs();
        if (cancelled) return;
        if (rows === null) {
          scheduleRetry();
          return;
        }
        setRefsBySession(groupBySession(rows));
      } catch (err) {
        log.warn('pr refs load failed, will retry', String(err));
        scheduleRetry();
      }
    };
    void load();

    const unsubscribe = window.electronAPI.gitContext.onPrRefsChanged((data) => {
      void (async () => {
        try {
          const refs = await window.electronAPI.gitContext.listPrRefs(data.sessionId);
          if (cancelled) return;
          setRefsBySession((prev) => {
            const next = new Map(prev);
            if (refs.length > 0) next.set(data.sessionId, refs);
            else next.delete(data.sessionId);
            return next;
          });
        } catch (err) {
          log.warn('pr refs refresh failed', String(err));
        }
      })();
    });

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [dataOwnerId]);

  // 回调身份稳定(空闭包依赖):refs 经 refsRef 读,statuses 经函数式 setState 写。
  const fetchStatusesForSession = useRef((sessionId: string) => {
    const refs = refsRef.current.get(sessionId)?.slice(0, MAX_STATUS_QUERIES);
    if (!refs || refs.length === 0) return;
    if (inFlightSessions.current.has(sessionId)) return;
    inFlightSessions.current.add(sessionId);
    void (async () => {
      try {
        const results = await window.electronAPI.gitContext.getPrStatuses(
          refs.map((r) => ({ owner: r.owner, repo: r.repo, prNumber: r.prNumber })),
        );
        setStatuses((prev) => {
          const next = new Map(prev);
          for (const r of results) next.set(prStatusKey(r), r);
          return next;
        });
      } catch (err) {
        log.warn('pr statuses fetch failed', String(err));
      } finally {
        inFlightSessions.current.delete(sessionId);
      }
    })();
  }).current;

  const statusesValue = useMemo(
    () => ({ statuses, fetchStatusesForSession }),
    [statuses, fetchStatusesForSession],
  );

  return (
    <PrRefsMapContext.Provider value={refsBySession}>
      <PrStatusesContext.Provider value={statusesValue}>{children}</PrStatusesContext.Provider>
    </PrRefsMapContext.Provider>
  );
}

/** 某会话的 PR 引用(无则空数组,引用稳定避免重渲染)。状态更新不触发本 hook。 */
const EMPTY_REFS: SessionPrRef[] = [];
export function usePrRefsForSession(sessionId: string): SessionPrRef[] {
  const refsBySession = useContext(PrRefsMapContext);
  return refsBySession.get(sessionId) ?? EMPTY_REFS;
}

/** tooltip 内容消费:状态缓存 + 按需拉取。仅打开中的 tip 因状态更新而重渲染。 */
export function usePrStatuses(): PrStatusesContextValue {
  return useContext(PrStatusesContext);
}
