/**
 * @cindy/remote-file-service — SSH 远端文件服务(daemon + client + 协议)。
 *
 * 消费方式:
 *  - desktop main:import { FileServiceClient } from './client.js' 经
 *    RemoteHost.execStream 连远端 daemon。
 *  - 远端 daemon:build.mjs 把 src/bin/file-service.ts 打成
 *    dist/file-service.mjs,由 maker-remote-ssh 安装器推送。
 */

export { runFileService, type FileServiceOptions } from './server.js';
export { WorkdirWatchManager, type RemoteFileTreeEvent } from './watch.js';
export {
  FileServiceClient,
  FileServiceRpcError,
  type FileServiceStream,
  type FileServiceClientLogger,
  type FileServiceClientOptions,
} from './client.js';
export * from './protocol.js';
export { NdjsonLineDecoder, encodeNdjsonFrame } from './codec.js';
