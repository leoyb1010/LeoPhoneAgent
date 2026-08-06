/**
 * DrawioPreview — 在 FileBodyView 里渲染 .drawio 文件。
 *
 * 策略:
 *   - drawio viewer-static.min.js 是 ~3.6MB 第三方脚本,不进 main bundle —
 *     首次打开 .drawio 文件时动态注入 <script>,后续打开同类文件直接复用
 *     已加载的 window.GraphViewer。
 *   - viewer 离线工作 (vendor 目录里有,Vite 通过 ?url 出 URL),不联网。
 *   - 文件内容(XML 文本)由父层 FileBodyView 经 useFileContent 已读好,
 *     直接传 xmlContent prop。不走 fetch(xdt-file://...) —— 该协议
 *     `corsEnabled: false`,fetch API 会被跨源拦掉(TypeError: Failed to fetch),
 *     同时也省一次冗余读取。
 *   - 失败 → 退回 UnrenderablePlaceholder。
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createLogger } from '@/lib/logger';

import viewerUrl from '@/vendor/drawio/viewer-static.min.js?url';
import { UnrenderablePlaceholder } from './UnrenderablePlaceholder';

const log = createLogger('DrawioPreview');

interface DrawioGraphViewer {
  /** drawio 源码里这个参数是 class name 字符串(默认 'mxgraph'),不是 scope 元素。
   *  传 DOM 元素会被 toString 成 "[object HTMLDivElement]" → 找不到任何元素 → 静默失败。 */
  processElements: (className?: string) => void;
  /** 给单个已含 data-mxgraph 的 div 直接创建 viewer,绕开全文档扫描。 */
  createViewerForElement: (element: HTMLElement) => unknown;
}

declare global {
  interface Window {
    GraphViewer?: DrawioGraphViewer;
  }
}

// 模块级 promise 复用 —— 第一次注入 script 就开始 race,后续 mount 共享同一个
// resolve。失败时清空,允许下一次重试(网络盘读不到 / SHA 损坏等极端场景)。
let viewerLoadPromise: Promise<DrawioGraphViewer> | null = null;

function loadViewerOnce(): Promise<DrawioGraphViewer> {
  if (window.GraphViewer) return Promise.resolve(window.GraphViewer);
  if (viewerLoadPromise) return viewerLoadPromise;
  viewerLoadPromise = new Promise<DrawioGraphViewer>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = viewerUrl;
    script.async = true;
    script.onload = () => {
      if (window.GraphViewer) {
        resolve(window.GraphViewer);
      } else {
        viewerLoadPromise = null;
        reject(new Error('drawio viewer loaded but GraphViewer is undefined'));
      }
    };
    script.onerror = () => {
      viewerLoadPromise = null;
      reject(new Error('failed to load drawio viewer-static.min.js'));
    };
    document.head.appendChild(script);
  });
  return viewerLoadPromise;
}

export interface DrawioPreviewProps {
  workdir: string;
  /** workdir-relative POSIX path */
  relPath: string;
  /** XML 文本内容,父层 useFileContent 已读出。 */
  xmlContent: string;
  size: number;
  mtimeMs: number;
}

type RenderState =
  | { kind: 'loading' }
  | { kind: 'rendered' }
  | { kind: 'error'; message: string };

export function DrawioPreview({ workdir, relPath, xmlContent, size, mtimeMs }: DrawioPreviewProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<RenderState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    setState({ kind: 'loading' });

    (async () => {
      try {
        const viewer = await loadViewerOnce();
        if (cancelled) return;
        // drawio 期望一个 <div class="mxgraph" data-mxgraph="{json}"> 容器,
        // 然后 processElements 扫该容器 (或全文档) 渲染。
        const host = document.createElement('div');
        host.className = 'mxgraph';
        host.style.maxWidth = '100%';
        host.setAttribute(
          'data-mxgraph',
          JSON.stringify({
            xml: xmlContent,
            highlight: '#0000ff',
            nav: true,
            resize: true,
            // 让 viewer 自动跟随 OS / 应用主题 (浅色仍是浅图,深色用对应反色)。
            'dark-mode': 'auto',
            // 关键: drawio 默认会检查 host.offsetWidth, 0 宽时挂 MutationObserver
            // 等 parent attribute 变化才渲染。React 动态挂载 + flex 布局下,host
            // 刚挂上去就是 0 宽, parent attribute 也不会再变, observer 永远等不到 →
            // viewer 静默卡住不渲染。设为 false 让 drawio 立即渲染,布局到位后
            // resize handler 会自适应宽度。
            'check-visible-state': false,
          }),
        );
        container.appendChild(host);
        // 不用 processElements(它的参数是 className 字符串,传 DOM 元素会被 toString
        // → 找不到任何元素 → 静默 no-op)。直接对单个 host 调 createViewerForElement。
        viewer.createViewerForElement(host);
        if (!cancelled) setState({ kind: 'rendered' });
      } catch (err) {
        if (cancelled) return;
        log.warn('drawio render failed', { relPath, error: String(err) });
        setState({ kind: 'error', message: String(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workdir, relPath, xmlContent]);

  if (state.kind === 'error') {
    return (
      <UnrenderablePlaceholder
        workdir={workdir}
        relPath={relPath}
        size={size}
        mtimeMs={mtimeMs}
      />
    );
  }

  return (
    <div
      className="relative h-full w-full overflow-auto bg-[var(--surface)]"
      style={{ colorScheme: 'light dark' }}
    >
      <div className="flex min-h-full items-center justify-center p-6">
        <div ref={containerRef} className="max-w-full" />
      </div>
      {state.kind === 'loading' && (
        <div className="absolute inset-x-0 bottom-3 text-center text-xs text-[var(--cmd-palette-item-meta)]">
          {t('ccAgent.workdirBrowse.fileBody.drawioLoading', {
            defaultValue: '正在渲染 drawio…',
          })}
        </div>
      )}
    </div>
  );
}
