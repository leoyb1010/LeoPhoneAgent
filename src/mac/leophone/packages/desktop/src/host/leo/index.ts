import type { Server } from "node:http";

import { IProviderSettingsService, ISettingService, IZCodeTaskService } from "@zcode/services";
import type { ServiceCollection } from "@zcode/services";
import { ZCODE_VERSION } from "@zcode/shared";

import { startLeoHttpApi } from "./httpApi.js";
import { linkEnabled, startLeoLink } from "./link/index.js";
import { registerTreasuryMcpServer } from "./registerTreasuryMcp.js";
import { syncSubscriptionProvider } from "./subscriptionProvider.js";
import { TreasuryStore } from "./treasuryStore.js";

type Logger = { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };

let started = false;
let httpServer: Server | null = null;
let store: TreasuryStore | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let link: Promise<{ stop(): Promise<void> } | null> | null = null;
let linkTimer: NodeJS.Timeout | null = null;

const PORT_RETRY_MS = 15_000;
/** 切换 / 回滚脚本改完 `~/.leoagent/link.json` 后,最多这么久桥接就跟上,不用重启 App。 */
const LINK_SYNC_MS = 15_000;

/**
 * [leo] 我们自己的几块:藏宝阁、手机连接(Leo Link)、订阅账号(OAuth)模型代理。
 * 聊天机器人遥控(Telegram / 飞书 / 微信)用上游的机器人服务,规则见 services/src/bots/leoBotPolicy.ts。
 *
 * 跟着 Window Host 的 services 一起活:会话与权限直接用 IZCodeTaskService,不另起 agent。
 * 每个窗口都有自己的 Host,但本地端口只有一个:谁抢到端口谁负责手机连接 / MCP 登记 / 订阅同步;
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
      httpServer = startLeoHttpApi({
        store,
        logger: deps.logger,
        onSubscriptionChanged: syncSubscriptions,
        onListening: () => {
          // 启动时对一次账:之前登过的订阅账号,模型清单要和它一致。
          syncSubscriptions();
          registerTreasuryMcpServer(deps.logger);
          // 手机经中继连回这台 Mac:只在抢到端口的这个 Host 里跑一份。
          // 跟着开关文件走:回滚时必须立刻让出机器名,否则和恢复注册的 leoagent 在中继上互踢。
          const syncLink = () => {
            const wanted = linkEnabled();
            if (wanted && !link) {
              link = startLeoLink({
                taskService,
                settingService: deps.services.get(ISettingService),
                logger: deps.logger,
                appVersion: ZCODE_VERSION,
              }).catch((error: unknown) => {
                deps.logger.warn("[leo/link] failed to start", { error: String(error) });
                return null;
              });
            } else if (!wanted && link) {
              const running = link;
              link = null;
              void running.then((started) => started?.stop());
              deps.logger.info("[leo/link] stopped (disabled)");
            }
          };
          syncLink();
          linkTimer ??= setInterval(syncLink, LINK_SYNC_MS);
          linkTimer.unref();
          deps.logger.info("[leo] treasury + link + subscription proxy ready");
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
  if (linkTimer) clearInterval(linkTimer);
  linkTimer = null;
  void link?.then((started) => started?.stop());
  link = null;
  httpServer?.close();
  store?.close();
  httpServer = null;
  store = null;
  started = false;
}
