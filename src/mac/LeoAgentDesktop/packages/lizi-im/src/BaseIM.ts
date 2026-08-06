/**
 * BaseIM — abstract base for every IM channel (feishu, slack, ...).
 * ---------------------------------------------------------------------------
 * Subclasses implement init / dispose / registerIpc; createIM aggregates them.
 *
 * The host adapter is held as a protected field so subclasses can reach it via
 * `this.host.secrets`, `this.host.ipc`, etc. without threading it through every
 * helper function.
 */

import { defaultLogger, type Logger } from './logger.js';
import type { IMHost } from './types.js';

export abstract class BaseIM {
  protected readonly log: Logger;

  protected constructor(
    public readonly name: string,
    protected readonly host: IMHost,
  ) {
    this.log = host.createLogger?.(`im:${name}`) ?? defaultLogger(`im:${name}`);
  }

  /** App ready 后调用。失败只记日志/emit 状态，绝不抛。 */
  abstract init(): Promise<void>;

  /** App 退出时调用。同步关连接、清资源。绝不抛。 */
  abstract dispose(): Promise<void>;

  /** App ready 时调用一次，注册 renderer↔main IPC handlers。 */
  abstract registerIpc(): void;
}
