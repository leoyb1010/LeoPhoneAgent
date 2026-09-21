import type { Server } from "node:http";

import { IProviderSettingsService, IZCodeTaskService } from "@zcode/services";
import type { ServiceCollection } from "@zcode/services";

import { startLeoHttpApi } from "./httpApi.js";
import { registerTreasuryMcpServer } from "./registerTreasuryMcp.js";
import { syncSubscriptionProvider } from "./subscriptionProvider.js";
import { TelegramChannel } from "./telegram.js";
import { TreasuryStore } from "./treasuryStore.js";

type Logger = { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };

let started = false;
let httpServer: Server | null = null;
let store: TreasuryStore | null = null;
let telegram: TelegramChannel | null = null;
let retryTimer: NodeJS.Timeout | null = null;

const PORT_RETRY_MS = 15_000;

/**
 * [leo] 我们自己的几块:藏宝阁、Telegram 通道、订阅账号(OAuth)模型代理。
 *
 * 跟着 Window Host 的 services 一起活:会话与权限直接用 IZCodeTaskService,不另起 agent。
 * 每个窗口都有自己的 Host,但本地端口只有一个:谁抢到端口谁负责 Telegram / MCP 登记 / 订阅同步;
 * 没抢到的隔一会儿再试,抢端口的那个窗口关掉后自动接手。
 */
export function startLeoHostServices(deps: { services: ServiceCollection; logger: Logger }): void {
  if (started) return;
  started = true;
  try {
    const taskService = deps.services.get(IZCodeTaskService);
    const providerSettings = deps.services.get(IProviderSettingsService);
    const syncSubscriptions = () => void syncSubscriptionProvider(providerSettings, deps.logger);
    const listen = () => {
      retryTimer = null;
      store ??= new TreasuryStore();
      telegram ??= new TelegramChannel(taskService, deps.logger);
      const liveTelegram = telegram;
      httpServer = startLeoHttpApi({
        store,
        telegram: liveTelegram,
        logger: deps.logger,
        onSubscriptionChanged: syncSubscriptions,
        onListening: () => {
          // 启动时对一次账:之前登过的订阅账号,模型清单要和它一致。
          syncSubscriptions();
          registerTreasuryMcpServer(deps.logger);
          void liveTelegram.start();
          deps.logger.info("[leo] treasury + telegram + subscription proxy ready");
        },
        onPortBusy: () => {
          httpServer?.close();
          httpServer = null;
          retryTimer = setTimeout(listen, PORT_RETRY_MS);
          retryTimer.unref();
        },
      });
    };
    listen();
  } catch (error) {
    // Leo 这几块是加分项,起不来不能拖垮整个 Host。
    started = false;
    deps.logger.warn("[leo] failed to start", { error: String(error) });
  }
}

export function stopLeoHostServices(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  telegram?.stop();
  httpServer?.close();
  store?.close();
  httpServer = null;
  store = null;
  telegram = null;
  started = false;
}
