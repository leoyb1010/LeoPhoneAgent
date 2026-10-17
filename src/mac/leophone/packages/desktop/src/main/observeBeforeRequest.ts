import type { WebRequest, OnBeforeRequestListenerDetails } from "electron";

type Observer = (details: OnBeforeRequestListenerDetails) => void;
/** [leo] 拦截者：返回 true 表示这条请求必须取消（官方服务兜底）。 */
type Blocker = (details: OnBeforeRequestListenerDetails) => boolean;
type RequestSource = Pick<WebRequest, "onBeforeRequest">;

interface SourceEntries {
  observers: Map<Observer, { urls: string[]; patterns: RegExp[] }>;
  blockers: Map<Blocker, { urls: string[]; patterns: RegExp[] }>;
}

const sources = new WeakMap<RequestSource, SourceEntries>();

function toPatterns(urls: string[]): RegExp[] {
  return urls.map(
    (pattern) =>
      new RegExp(
        `^${pattern
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      ),
  );
}

function entriesFor(source: RequestSource): SourceEntries {
  let entries = sources.get(source);
  if (!entries) {
    entries = { observers: new Map(), blockers: new Map() };
    sources.set(source, entries);
  }
  return entries;
}

/**
 * 同一个 session 只装一个 onBeforeRequest：Electron 同一事件只保留最后一个 listener，
 * 观测者与拦截者都必须经过这个分发入口，否则后注册的会把先注册的顶掉，
 * 而观测者全部退订时的 `onBeforeRequest(null)` 会把拦截一并清除。
 *
 * [leo] 3.15.1 的资源管理器「网络」面板开始抓包时会在 defaultSession 上重新注册监听、
 * 停止时 `onBeforeRequest(null)`。LeoBot 的官方服务兜底（leoSessionGuard）因此改成在这里登记
 * 「拦截者」：只要还有拦截者，监听就一直在，抓包开 / 关都不影响拦截。
 */
function update(source: RequestSource, entries: SourceEntries): void {
  if (!entries.observers.size && !entries.blockers.size) {
    source.onBeforeRequest(null);
    sources.delete(source);
    return;
  }
  const urls = [
    ...new Set(
      [...entries.blockers.values(), ...entries.observers.values()].flatMap((entry) => entry.urls),
    ),
  ];
  source.onBeforeRequest({ urls }, (details, callback) => {
    let cancel = false;
    for (const [blocker, entry] of entries.blockers) {
      try {
        if (entry.patterns.some((pattern) => pattern.test(details.url)) && blocker(details)) {
          cancel = true;
          break;
        }
      } catch {
        /* 拦截者异常按不拦截处理，不阻断网络 */
      }
    }
    callback(cancel ? { cancel: true } : {});
    for (const [listener, entry] of entries.observers) {
      try {
        if (entry.patterns.some((pattern) => pattern.test(details.url))) listener(details);
      } catch {
        /* 观测错误不得阻断网络或其他观测者 */
      }
    }
  });
}

/** Electron 同一事件只保留最后一个 listener，观测者必须共用这个只读分发入口。 */
export function subscribeBeforeRequest(
  source: RequestSource,
  urls: string[],
  observer: Observer,
): () => void {
  const entries = entriesFor(source);
  entries.observers.set(observer, { urls, patterns: toPatterns(urls) });
  update(source, entries);
  return () => {
    entries.observers.delete(observer);
    update(source, entries);
  };
}

/**
 * [leo] 在同一分发入口上登记拦截者。拦截者先于观测者执行；任一拦截者返回 true 即取消请求
 * （被取消的请求仍会交给观测者，资源管理器里能看到它被拦下）。
 */
export function blockBeforeRequest(
  source: RequestSource,
  urls: string[],
  blocker: Blocker,
): () => void {
  const entries = entriesFor(source);
  entries.blockers.set(blocker, { urls, patterns: toPatterns(urls) });
  update(source, entries);
  return () => {
    entries.blockers.delete(blocker);
    update(source, entries);
  };
}
