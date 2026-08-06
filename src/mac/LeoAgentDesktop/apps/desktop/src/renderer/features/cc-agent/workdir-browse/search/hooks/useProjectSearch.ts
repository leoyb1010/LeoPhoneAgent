/**
 * useProjectSearch — 渲染层 hook,封装项目级文本搜索的:
 *   - 250ms debounce 输入
 *   - start / cancel 走 main IPC
 *   - 订阅 push event 累积结果到 Map<filePath, MatchLine[]>
 *   - 用 requestAnimationFrame 节流刷 UI(避免 1000 条命中时每条都 setState)
 *
 * 调用方传入 query / caseSensitive(以及外部决定的 maxMatches),hook 内部保证:
 *   - 每次 query/option 变化都先 cancel 上一次 search
 *   - 卸载时彻底 cancel + 释放订阅
 *   - workdir 变化时清空累积结果
 *
 * 状态机:
 *   idle      — 还没搜过 / query 为空
 *   searching — 已发出 start, 正在收 match
 *   done      — 收到 end({ truncated: false })
 *   truncated — 收到 end({ truncated: true })
 *   error     — main 端 spawn rg 失败 / start 返回 ok=false
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';
import { deviceSearchCollect } from '@/lib/fileBrowserTransport';

const log = createLogger('cc-agent.workdir-browse.search');

/** onEvent 回调事件形状(从 preload 契约推导,replay 回放共用)。 */
type SearchPushEvent = Parameters<Parameters<typeof window.electronAPI.search.onEvent>[0]>[0];

const DEBOUNCE_MS = 250;

export interface MatchLine {
  lineNumber: number;
  lineText: string;
  submatches: Array<{ start: number; end: number }>;
}

export interface FileResult {
  relPath: string;
  matches: MatchLine[];
}

export type SearchStatus = 'idle' | 'searching' | 'done' | 'truncated' | 'error';

export interface UseProjectSearchParams {
  workdir: string;
  /** 非空 = SSH remote 会话:搜索在远端 daemon 内跑远端 rg,事件流形状与本地一致。 */
  remoteHostId?: string | null;
  /**
   * 非空 = device-link 远程会话:走被控端 searchCollect(非流式,一次性拿全量
   * 后本地回放成与流式一致的 results 形态)。与 remoteHostId 互斥,deviceId 优先。
   */
  deviceId?: string | null;
  query: string;
  caseSensitive: boolean;
  maxMatches: number;
}

export interface UseProjectSearchReturn {
  /** 按文件分组的命中结果, 按文件第一次出现的顺序排列(就是 rg 的扫描顺序)。 */
  results: FileResult[];
  /** 累计命中数 (= 所有 match 个数);搜索过程中持续累加。 */
  totalMatches: number;
  /** 累计文件数。 */
  totalFiles: number;
  status: SearchStatus;
  errorMessage: string | null;
  /** 稳定错误码(如 RG_UNAVAILABLE),UI 按码映射友好文案;无码时为 null 走 errorMessage。 */
  errorCode: string | null;
  /** 立即清空 (用于 workdir 切换 / 用户 X 按钮)。 */
  clear: () => void;
}

export function useProjectSearch(params: UseProjectSearchParams): UseProjectSearchReturn {
  const { workdir, remoteHostId = null, deviceId = null, query, caseSensitive, maxMatches } = params;

  // 累积态: 用 ref 存"权威数据", state 存"渲染快照"。 收 match 高频,直接 setState
  // 会让 React 一秒 reconcile 几百次,所以拉一层 rAF flush 节流。
  const resultsMapRef = useRef<Map<string, MatchLine[]>>(new Map());
  const fileOrderRef = useRef<string[]>([]);
  const totalMatchesRef = useRef(0);
  const flushScheduledRef = useRef(false);

  const [results, setResults] = useState<FileResult[]>([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [totalFiles, setTotalFiles] = useState(0);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // 当前 active searchId(用于过滤 stale 事件: rapid 输入下旧 search 可能还有
  // event 在路上, 不能让它污染新的累积态)。
  // 取消必须发回**启动时**的端点:跨端点(同 workdir)切换后用新 render 的
  // remoteHostId 去 cancel,旧 host/本地的 rg 进程与 main 监听会一直跑到自然
  // 结束。故 id 与端点一起存。
  const activeSearchRef = useRef<{ id: string; remoteHostId: string | null } | null>(null);

  const flushNow = useCallback(() => {
    flushScheduledRef.current = false;
    const next: FileResult[] = fileOrderRef.current.map((relPath) => ({
      relPath,
      matches: resultsMapRef.current.get(relPath) ?? [],
    }));
    setResults(next);
    setTotalMatches(totalMatchesRef.current);
    setTotalFiles(fileOrderRef.current.length);
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    requestAnimationFrame(flushNow);
  }, [flushNow]);

  const resetAccum = useCallback(() => {
    resultsMapRef.current = new Map();
    fileOrderRef.current = [];
    totalMatchesRef.current = 0;
    flushScheduledRef.current = false;
    setResults([]);
    setTotalMatches(0);
    setTotalFiles(0);
    setErrorMessage(null);
    setErrorCode(null);
  }, []);

  const clear = useCallback(() => {
    activeSearchRef.current = null;
    resetAccum();
    setStatus('idle');
  }, [resetAccum]);

  // workdir 切换 → 强制清空(用户答复:"切 workdir 时清掉")。
  useEffect(() => {
    clear();
  }, [workdir, clear]);

  /** 单条 search 事件的消费体。两个入口共用:onEvent 订阅流(searchId 过滤后)
   *  与 start 响应携带的 replay 回放(启动窗口内 daemon 秒回的事件,main 若
   *  直接 push 会先于 start 响应到达、被 stale 过滤丢弃,故随响应带回)。 */
  const applySearchEvent = useCallback(
    (evt: SearchPushEvent) => {
      if (evt.type === 'match') {
        const existing = resultsMapRef.current.get(evt.relPath);
        if (!existing) {
          fileOrderRef.current.push(evt.relPath);
          resultsMapRef.current.set(evt.relPath, [
            {
              lineNumber: evt.lineNumber,
              lineText: evt.lineText,
              submatches: evt.submatches,
            },
          ]);
        } else {
          existing.push({
            lineNumber: evt.lineNumber,
            lineText: evt.lineText,
            submatches: evt.submatches,
          });
        }
        totalMatchesRef.current += 1;
        scheduleFlush();
      } else if (evt.type === 'end') {
        flushNow();
        setStatus(evt.truncated ? 'truncated' : 'done');
        activeSearchRef.current = null;
      } else if (evt.type === 'error') {
        flushNow();
        setStatus('error');
        setErrorMessage(evt.message);
        activeSearchRef.current = null;
      }
    },
    [flushNow, scheduleFlush],
  );

  // 订阅 main 推过来的 search event, 在组件存活期间始终挂着。
  // 同 key 的 stale 事件靠 activeSearchRef 过滤。
  useEffect(() => {
    const unsub = window.electronAPI.search.onEvent((evt) => {
      if (evt.searchId !== activeSearchRef.current?.id) return;
      applySearchEvent(evt);
    });
    return () => {
      unsub();
    };
  }, [applySearchEvent]);

  // 查询 + 选项 + workdir 变化 → 250ms debounce 后启新 search。
  // 启新前先取消旧的(无论旧的是不是已 end, cancel 都是 no-op safe)。
  useEffect(() => {
    const trimmed = query.trim();
    if (!workdir || !trimmed) {
      // 空查询直接清掉 + 取消正在跑的(避免上次输入残留)。
      if (activeSearchRef.current) {
        const stale = activeSearchRef.current;
        activeSearchRef.current = null;
        void window.electronAPI.search.cancel({ searchId: stale.id, remoteHostId: stale.remoteHostId });
      }
      resetAccum();
      setStatus('idle');
      return;
    }

    // 本 effect 实例的取消旗标:query/选项变化会触发 cleanup,让仍在途的
    // 异步启动(device collect / search.start 的 await)作废——否则旧 query 的
    // collect 迟到后会把过期结果整批灌进已清空的累积器(非流式无 searchId 过滤)。
    let cancelled = false;
    const timer = setTimeout(() => {
      // 1. cancel 旧的(若有)
      if (activeSearchRef.current) {
        const stale = activeSearchRef.current;
        activeSearchRef.current = null;
        void window.electronAPI.search.cancel({ searchId: stale.id, remoteHostId: stale.remoteHostId });
      }
      // 2. 清累积态(新 query 不能复用旧结果)
      resetAccum();
      setStatus('searching');
      // 3. 启新
      void (async () => {
        try {
          if (deviceId) {
            // device-link:非流式 collect(被控端一次性收集),拿到后整批灌入
            // 累积器 —— UI 得到与流式一致的 results / totalMatches / end 态。
            const collected = await deviceSearchCollect(deviceId, {
              workdir,
              query: trimmed,
              caseSensitive,
              maxMatches,
            });
            if (cancelled) return; // query 已变:丢弃过期 collect
            for (const m of collected.matches) {
              const line = {
                lineNumber: m.lineNumber,
                lineText: m.lineText,
                submatches: m.submatches,
              };
              const existing = resultsMapRef.current.get(m.relPath);
              if (!existing) {
                fileOrderRef.current.push(m.relPath);
                resultsMapRef.current.set(m.relPath, [line]);
              } else {
                existing.push(line);
              }
              totalMatchesRef.current += 1;
            }
            flushNow();
            setTotalMatches(collected.totalMatches);
            setTotalFiles(fileOrderRef.current.length);
            setStatus(collected.truncated ? 'truncated' : 'done');
            return;
          }
          const res = await window.electronAPI.search.start({
            workdir,
            remoteHostId,
            query: trimmed,
            caseSensitive,
            maxMatches,
          });
          if (cancelled) {
            // query 已变:别把过期 searchId 写进 ref(会挤掉新 search 的过滤键),
            // 直接取消这条迟到启动的搜索。
            if (res.ok) void window.electronAPI.search.cancel({ searchId: res.searchId, remoteHostId });
            return;
          }
          if (!res.ok) {
            log.warn('search start rejected', { message: res.message, code: res.code });
            setStatus('error');
            setErrorMessage(res.message);
            setErrorCode(res.code ?? null);
            return;
          }
          activeSearchRef.current = { id: res.searchId, remoteHostId };
          // 回放随响应带回的启动窗口事件(可能已含终态)。
          if (res.replay) {
            for (const evt of res.replay) {
              if (evt.searchId !== res.searchId) continue;
              applySearchEvent(evt);
            }
          }
        } catch (err) {
          if (cancelled) return; // 过期请求的失败不污染新 query 的状态
          log.error('search start threw', { error: String(err) });
          setStatus('error');
          setErrorMessage(String(err));
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [workdir, remoteHostId, deviceId, query, caseSensitive, maxMatches, resetAccum, applySearchEvent]);

  // 卸载 → 取消 active search(避免组件没了 rg 还在跑)。端点随 id 一起存在
  // activeSearchRef 里,取消天然回到启动时的端点。
  useEffect(() => {
    return () => {
      const stale = activeSearchRef.current;
      if (stale) {
        activeSearchRef.current = null;
        void window.electronAPI.search.cancel({
          searchId: stale.id,
          remoteHostId: stale.remoteHostId,
        });
      }
    };
  }, []);

  return useMemo(
    () => ({ results, totalMatches, totalFiles, status, errorMessage, errorCode, clear }),
    [results, totalMatches, totalFiles, status, errorMessage, errorCode, clear],
  );
}
