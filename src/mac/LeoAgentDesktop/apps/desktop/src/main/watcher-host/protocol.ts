/**
 * watcher-host 协议 — main 进程与 watcher utility process 之间的消息契约。
 *
 * 背景:@parcel/watcher 是 native 模块(Win: ReadDirectoryChangesW),它的
 * subscribe/unsubscribe 在快速切 session 场景下疑似触发过 native 层硬崩溃
 * (2026-07-07 Release 崩溃,主进程无 JS 异常、无 dump、日志在 watcher stop
 * 后戛然而止)。把所有 parcel 订阅挪进独立 utility process 后,native 崩溃
 * 最多带走子进程,主进程通过重启 + 重订阅恢复,应用本体不再受影响。
 *
 * 本文件是纯类型 + 常量,main 侧 client 与 host 进程两端共享,不 import 任何
 * Electron / Node 运行时依赖。
 */

/** parcel 原生事件的直传形态(host 不做业务过滤,matcher 过滤留在 main)。 */
export interface WatchedFsEvent {
  type: 'create' | 'update' | 'delete';
  path: string;
}

/** main → host 的 RPC 请求。id 由 client 分配,响应按 id 配对。 */
export type WatcherHostRequest =
  | {
      id: number;
      op: 'subscribe';
      /** client 分配的订阅句柄 id,事件推送按它路由回调。 */
      subId: number;
      dir: string;
      /** 绝对路径 ignore 预剪列表(parcel 的 ignore 选项,非 glob)。 */
      ignore: string[];
    }
  | { id: number; op: 'unsubscribe'; subId: number };

/** host → main 的 RPC 响应。 */
export type WatcherHostResponse =
  | { kind: 'response'; id: number; ok: true }
  | { kind: 'response'; id: number; ok: false; error: string };

/** host → main 的主动推送(无 id)。 */
export type WatcherHostPush =
  | { kind: 'push'; event: 'fs-events'; subId: number; events: WatchedFsEvent[] }
  | { kind: 'push'; event: 'watch-error'; subId: number; message: string }
  | { kind: 'push'; event: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export type WatcherHostMessage = WatcherHostResponse | WatcherHostPush;

/**
 * main 侧解析好的 @parcel/watcher 模块入口绝对路径,经 fork env 传给 host,
 * 避免子进程在 packaged(asar.unpacked)布局下裸 require 猜错解析根
 * (与 db-worker 传 betterSqliteModulePath 同一套路)。
 */
export const WATCHER_HOST_ENV_PARCEL_MODULE = 'XDT_PARCEL_WATCHER_MODULE';
