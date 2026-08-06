/**
 * AnnotationBurnInWebView — 标注烧录的隐藏 WebView host(手机版)。
 *
 * RN 没有 DOM canvas,烧录(原图 + 矢量笔迹 → 位图)在一个 1x1 隐藏 WebView
 * 里完成:canvas 重放算法与桌面版逐行对应(见 imageAnnotationModel 的
 * buildAnnotationBurnInHtml),纯 JS 方案零新增原生依赖,可随 OTA 热更。
 *
 * useAnnotationBurnIn() 返回 promise 风格的 burnIn API 与 host 元素;host 按需
 * 挂载(有任务才渲染 WebView,空闲零开销),任务串行执行,页面把 host 挂在
 * 任意稳定位置即可。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import {
  buildAnnotationBurnInHtml,
  buildAnnotationBurnInInvocation,
  parseAnnotationBurnInMessage,
  type AnnotationStroke,
} from '@/session/imageAnnotationModel';

export interface AnnotationBurnInInput {
  /** 原图字节(纯 base64,无 data: 前缀)。 */
  base64: string;
  mimeType: string;
  strokes: readonly AnnotationStroke[];
}

export interface AnnotationBurnInResult {
  base64: string;
  mimeType: string;
  /** 烧录输出的像素尺寸(0 = WebView 回包缺失):供上传前降采样决策使用。 */
  width: number;
  height: number;
}

/** 单次烧录超时:大图解码 + 编码在低端机上也应远低于此,超时视为失败降级。 */
const BURN_IN_TIMEOUT_MS = 30_000;
/**
 * WebView 挂载 → ready 回包的兜底超时:WebView 加载失败 / JS 早退 / 低内存被杀
 * 时永远等不到 ready,任务级超时(注入时刻才起表)覆盖不到这段——不兜底的话
 * burnIn promise 永不 settle,lightbox 卡在提交转圈且取消也被禁用(review P2)。
 */
const WEBVIEW_READY_TIMEOUT_MS = 10_000;

interface BurnInJob {
  id: string;
  input: AnnotationBurnInInput;
  resolve: (result: AnnotationBurnInResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface UseAnnotationBurnInResult {
  /** 烧录一张图;失败(解码/编码/超时)reject,调用方自行降级。 */
  burnIn: (input: AnnotationBurnInInput) => Promise<AnnotationBurnInResult>;
  /** 挂到页面任意稳定位置;无任务时为 null。 */
  host: ReactElement | null;
}

export function useAnnotationBurnIn(): UseAnnotationBurnInResult {
  // hasJobs 只负责驱动 host 挂载/卸载;任务真相全在 ref(onMessage 回调闭包稳定)。
  const [hasJobs, setHasJobs] = useState(false);
  const queueRef = useRef<BurnInJob[]>([]);
  const readyRef = useRef(false);
  const webViewRef = useRef<WebView | null>(null);
  const seqRef = useRef(0);

  // 前置声明打破 settleActive ↔ dispatchJob 的循环引用(经 ref 调用)。
  const dispatchJobRef = useRef<(job: BurnInJob) => void>(() => undefined);

  /** WebView 起不来(见 WEBVIEW_READY_TIMEOUT_MS):全队失败 + 卸载,下次任务重新挂载重试。 */
  const failAllPending = useCallback((error: Error) => {
    const jobs = queueRef.current.splice(0);
    for (const job of jobs) {
      if (job.timer) clearTimeout(job.timer);
      job.reject(error);
    }
    readyRef.current = false;
    setHasJobs(false);
  }, []);

  useEffect(() => {
    if (!hasJobs || readyRef.current) return undefined;
    const timer = setTimeout(() => {
      // ready 已到则 no-op(effect 不因 ready 重跑,靠回调时刻的 ref 判断)。
      if (!readyRef.current && queueRef.current.length > 0) {
        failAllPending(new Error('annotation burn-in webview failed to initialize'));
      }
    }, WEBVIEW_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [hasJobs, failAllPending]);

  // host 卸载(页面退出/失焦销毁)时在飞与排队任务全部显式 reject:不兜底的话
  // burnIn promise 永不 settle,而信箱已被 drain,调用方的 catch 回投也不会跑,
  // 用户笔迹静默丢失(review P2)。reject 后走既有失败链路(Alert / 信箱回投)。
  useEffect(() => () => {
    failAllPending(new Error('annotation burn-in host unmounted'));
  }, [failAllPending]);

  const settleActive = useCallback((settle: (job: BurnInJob) => void) => {
    const job = queueRef.current.shift();
    if (!job) return;
    if (job.timer) clearTimeout(job.timer);
    settle(job);
    const next = queueRef.current[0];
    if (next && readyRef.current) {
      dispatchJobRef.current(next);
    } else if (!next) {
      readyRef.current = false;
      setHasJobs(false); // 卸载 WebView,下次任务重新挂载 + ready
    }
  }, []);

  /**
   * 把队首 job 注入 WebView 并**此刻**起表:超时预算只覆盖真正在跑的任务,
   * 排队中的任务不计时——否则第一张大图会吃掉后续任务的预算,多图/信箱
   * 批量提交被误杀(review P2)。超时的 job 必为队首(仅被 dispatch 的有 timer)。
   */
  const dispatchJob = useCallback((job: BurnInJob) => {
    job.timer = setTimeout(() => {
      settleActive((j) => j.reject(new Error('annotation burn-in timed out')));
    }, BURN_IN_TIMEOUT_MS);
    webViewRef.current?.injectJavaScript(buildAnnotationBurnInInvocation({
      id: job.id,
      base64: job.input.base64,
      mimeType: job.input.mimeType,
      strokes: job.input.strokes,
    }));
  }, [settleActive]);
  dispatchJobRef.current = dispatchJob;

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    const message = parseAnnotationBurnInMessage(event.nativeEvent.data);
    if (!message) return;
    if ('ready' in message) {
      readyRef.current = true;
      const job = queueRef.current[0];
      if (job) dispatchJob(job);
      return;
    }
    const active = queueRef.current[0];
    if (!active || message.id !== active.id) return; // 过期回包(超时后到达)丢弃
    if (message.ok) {
      settleActive((job) => job.resolve({
        base64: message.base64,
        mimeType: message.mimeType,
        width: message.width,
        height: message.height,
      }));
    } else {
      settleActive((job) => job.reject(new Error(`annotation burn-in failed: ${message.error}`)));
    }
  }, [settleActive, dispatchJob]);

  const burnIn = useCallback((input: AnnotationBurnInInput): Promise<AnnotationBurnInResult> => {
    return new Promise<AnnotationBurnInResult>((resolve, reject) => {
      seqRef.current += 1;
      const job: BurnInJob = {
        id: `burn-${seqRef.current}`,
        input,
        resolve,
        reject,
        timer: null, // 计时在 dispatchJob(注入时刻)才启动,排队不占预算
      };
      queueRef.current.push(job);
      if (queueRef.current.length === 1) {
        if (readyRef.current) {
          dispatchJob(job);
        } else {
          setHasJobs(true); // 触发挂载;ready 回包后自动开跑
        }
      }
    });
  }, [dispatchJob]);

  const host = useMemo<ReactElement | null>(() => {
    if (!hasJobs) return null;
    return (
      <View pointerEvents="none" style={styles.hidden}>
        <WebView
          javaScriptEnabled
          onMessage={handleMessage}
          originWhitelist={['*']}
          ref={webViewRef}
          scrollEnabled={false}
          setSupportMultipleWindows={false}
          source={{ html: buildAnnotationBurnInHtml(), baseUrl: 'https://xdt-maker-mobile.local' }}
          style={styles.webView}
        />
      </View>
    );
  }, [hasJobs, handleMessage]);

  return { burnIn, host };
}

const styles = StyleSheet.create({
  hidden: {
    height: 1,
    left: 0,
    opacity: 0,
    position: 'absolute',
    top: 0,
    width: 1,
  },
  webView: { height: 1, width: 1 },
});
