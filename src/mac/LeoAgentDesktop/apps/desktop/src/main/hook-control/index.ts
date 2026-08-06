/**
 * hook-control —— desktop 与用户自部署 hook server 的接入层(第二步)。
 * 详见各文件头: store(配置存储) / transport(WS 拨出) / manager(编排) /
 * ipc(Electron 组装)。
 */

export {
  registerHookControlIpc,
  startHookControlAccount,
  stopHookControlAccount,
  resetHookControlOwnerBoundary,
  disposeHookControl,
} from './ipc.js';
