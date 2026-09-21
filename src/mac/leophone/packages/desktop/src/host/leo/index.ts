import type { Server } from "node:http";

import { IZCodeTaskService } from "@zcode/services";
import type { ServiceCollection } from "@zcode/services";

import { startLeoHttpApi } from "./httpApi.js";
import { TelegramChannel } from "./telegram.js";
import { TreasuryStore } from "./treasuryStore.js";

type Logger = { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };

let started = false;
let httpServer: Server | null = null;
let store: TreasuryStore | null = null;
let telegram: TelegramChannel | null = null;

/**
 * [leo] 我们自己的两块东西:藏宝阁与 Telegram 通道。
 *
 * 跟着 Window Host 的 services 一起活:会话与权限直接用 IZCodeTaskService,
 * 不另起 agent、不另开一份数据库连接。一个窗口起一次,重复调用直接返回。
 */
export function startLeoHostServices(deps: { services: ServiceCollection; logger: Logger }): void {
  if (started) return;
  started = true;
  try {
    const taskService = deps.services.get(IZCodeTaskService);
    store = new TreasuryStore();
    telegram = new TelegramChannel(taskService, deps.logger);
    httpServer = startLeoHttpApi({ store, telegram, logger: deps.logger });
    void telegram.start();
    deps.logger.info("[leo] treasury + telegram ready");
  } catch (error) {
    // Leo 这两块是加分项,起不来不能拖垮整个 Host。
    started = false;
    deps.logger.warn("[leo] failed to start", { error: String(error) });
  }
}

export function stopLeoHostServices(): void {
  telegram?.stop();
  httpServer?.close();
  store?.close();
  httpServer = null;
  store = null;
  telegram = null;
  started = false;
}
