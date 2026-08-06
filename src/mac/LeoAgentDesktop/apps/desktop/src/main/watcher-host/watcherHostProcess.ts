/**
 * watcherHostProcess — watcher utility process 入口(独立 vite entry,产物
 * .vite/build/watcherHostProcess.js,由 main 侧 WatcherHostClient 经
 * utilityProcess.fork 拉起)。
 *
 * 职责只有接线:加载真实 @parcel/watcher、把 process.parentPort 的消息串行
 * 喂给 WatcherHostCore、把 core 的消息 post 回 main。所有可测逻辑都在
 * WatcherHostCore 里,本文件不写业务。
 *
 * native 崩溃语义:parcel 的 Windows backend 若在本进程内硬崩,死的只是这个
 * utility process;main 侧 client 收到 exit 后按退避重启并重放全部订阅。
 *
 * 日志:本进程不落盘,统一以 push log 消息发回 main,由 main 的 logger 记录
 * (规则 12:不 console.log)。
 */

import { createRequire } from 'node:module';

import { WatcherHostCore, type ParcelLike } from './WatcherHostCore';
import {
  WATCHER_HOST_ENV_PARCEL_MODULE,
  type WatcherHostMessage,
  type WatcherHostRequest,
} from './protocol';

const _require = createRequire(__filename);

/**
 * 加载 @parcel/watcher:
 *  - 优先 main 传来的解析好的模块路径(packaged 布局下最可靠);
 *  - 支持 XDT_PARCEL_WATCHER_NODE 诊断开关(直接 require 指定 .node,套
 *    parcel wrapper),语义与旧 main 内加载一致;
 *  - 兜底裸 require(dev / vitest 布局)。
 * 同时显式 require 平台子包确认 prebuilt 命中(miss 时 warn,parcel 会退化
 * 到慢路径,不该无声发生)。
 */
function loadParcel(post: (msg: WatcherHostMessage) => void): ParcelLike {
  const t0 = Date.now();
  const override = process.env.XDT_PARCEL_WATCHER_NODE;
  let mod: ParcelLike;
  let detail: string;
  if (override) {
    const binding = _require(override);
    const wrapperMod = _require('@parcel/watcher/wrapper.js') as {
      createWrapper: (b: unknown) => ParcelLike;
    };
    mod = wrapperMod.createWrapper(binding);
    detail = `override=${override}`;
  } else {
    const modulePath = process.env[WATCHER_HOST_ENV_PARCEL_MODULE];
    mod = (modulePath ? _require(modulePath) : _require('@parcel/watcher')) as ParcelLike;
    const subName =
      process.platform === 'linux'
        ? `@parcel/watcher-${process.platform}-${process.arch}-glibc`
        : `@parcel/watcher-${process.platform}-${process.arch}`;
    let subOk = false;
    try {
      _require(subName);
      subOk = true;
    } catch {
      post({
        kind: 'push',
        event: 'log',
        level: 'warn',
        message: `platform subpkg require failed: ${subName}`,
      });
    }
    detail = `modulePath=${modulePath ?? '(bare require)'} subpkg=${subName}(${subOk ? 'ok' : 'MISSING'})`;
  }
  post({
    kind: 'push',
    event: 'log',
    level: 'info',
    message: `@parcel/watcher loaded in watcher host: total=${Date.now() - t0}ms ${detail}`,
  });
  return mod;
}

/** Electron utility process 的 parentPort 最小面(electron 类型不在本 entry 依赖里)。 */
interface ParentPortLike {
  postMessage(msg: unknown): void;
  on(event: 'message', cb: (e: { data: unknown }) => void): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

if (parentPort) {
  const post = (msg: WatcherHostMessage): void => parentPort.postMessage(msg);
  let parcel: ParcelLike | null = null;
  const core = new WatcherHostCore({
    loadParcel: () => {
      if (!parcel) parcel = loadParcel(post);
      return parcel;
    },
    post,
  });
  // 全局串行化:core 的簿记假设请求不交错(subscribe await 期间不插入同
  // subId 的 unsubscribe)。watcher 请求量极低(人切 session 的频率),串行
  // 不构成吞吐问题。
  let queue: Promise<void> = Promise.resolve();
  parentPort.on('message', (e) => {
    const req = e.data as WatcherHostRequest;
    queue = queue.then(() => core.handleRequest(req));
  });
}
