import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { IProviderSettingsService } from "@zcode/services";

import { LEO_HTTP_PORT, leoLocalKey, leoPath } from "./leoPaths.js";
import { loggedInModels } from "./oauthRuntime.js";

type Logger = { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };

const PROVIDER_NAME = "订阅账号(Claude / ChatGPT / Copilot)";
const ID_FILE = leoPath("oauth", "provider-id");

function isLocalProxy(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return true;
  try {
    const url = new URL(baseUrl);
    return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && Number(url.port) === LEO_HTTP_PORT;
  } catch {
    return false;
  }
}

function readProviderId(): string | null {
  try {
    return existsSync(ID_FILE) ? readFileSync(ID_FILE, "utf8").trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * [leo] 把本机模型代理登记成一个「个人供应商」,模型清单跟着已登录的订阅账号走。
 *
 * 用的是设置页同一套服务(IProviderSettingsService):登录一家,那家的模型就出现在
 * 模型选择里;退出就从清单里拿掉。代理地址只在 127.0.0.1,key 是本机那把。
 */
export async function syncSubscriptionProvider(
  providerSettings: IProviderSettingsService,
  logger: Logger,
): Promise<void> {
  try {
    const models = await loggedInModels();
    const view = (await providerSettings.getView()) as unknown as {
      providers?: Array<{
        providerId: string;
        personalModelIds?: readonly string[];
        models?: Array<{ modelId: string }>;
        effectiveConfig?: { api?: { baseUrl?: string | null } };
      }>;
    };
    let providerId = readProviderId();
    let existing = providerId ? view.providers?.find((p) => p.providerId === providerId) : undefined;

    // 这个供应商只在还指向本机代理时归我们管。你在设置里把它改成了自己的网关(地址不是本机代理),
    // 它就是你的了:不删你加的模型、不改你的地址和钥匙;订阅账号登录后另建一个供应商。
    // 以前没有这道判断,没登订阅账号时每次启动都会清空它的模型。
    if (existing && !isLocalProxy(existing.effectiveConfig?.api?.baseUrl)) {
      logger.info("[leo] 订阅供应商已被改成自定义网关,不再同步它");
      existing = undefined;
      providerId = null;
      if (models.length === 0) return;
    }

    if (models.length === 0) {
      // 一个账号都没登:有登记过的就清空模型,但保留供应商条目(下次登录直接复用)。
      if (existing) {
        for (const model of existing.models ?? []) {
          await providerSettings.deletePersonalModel(providerId!, model.modelId as never);
        }
      }
      return;
    }

    if (!existing) {
      const created = await providerSettings.createPersonalProvider({ providerName: PROVIDER_NAME, locale: "zh-CN" } as never);
      providerId = created.providerId as unknown as string;
      writeFileSync(ID_FILE, `${providerId}\n`, { mode: 0o600 });
    }

    await providerSettings.savePersonalProviderOverlay(
      providerId as never,
      {
        access: { type: "api-key", apiKey: leoLocalKey() },
        api: { type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${LEO_HTTP_PORT}/v1` },
      } as never,
      { providerName: PROVIDER_NAME, enabled: true } as never,
    );

    const current = new Set((existing?.models ?? []).map((m) => m.modelId));
    const wanted = new Set(models.map((m) => m.id));
    for (const model of models) {
      if (current.has(model.id)) continue;
      await providerSettings.addPersonalModel(
        providerId as never,
        model.id as never,
        {
          properties: {
            contextWindow: model.contextWindow,
            supportsToolCall: true,
            inputFormat: { supportsText: true, supportsImage: model.supportsImage },
          },
        } as never,
        true,
      );
    }
    for (const modelId of current) {
      if (!wanted.has(modelId)) await providerSettings.deletePersonalModel(providerId as never, modelId as never);
    }
    logger.info(`[leo] 订阅供应商已同步:${models.length} 个模型`);
  } catch (error) {
    logger.warn("[leo] 订阅供应商同步失败", { error: String(error) });
  }
}
