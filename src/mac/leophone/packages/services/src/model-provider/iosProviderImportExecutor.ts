import type {
  ProviderConfigObject,
  ProviderSettingsFacade,
  ProviderSettingsView,
} from "@zcode/provider";
import {
  buildRecommendedModelConfigPatch,
  isKeylessLocalBaseUrl,
} from "@zcode/shared/model-discovery";
import {
  PROVIDER_IMPORT_LIMITS,
  type ProviderImportItemResult,
  type ProviderImportRequest,
  type ProviderImportResult,
} from "@zcode/shared/provider-import";
import {
  decideImport,
  parseIosProviderFile,
  type ExistingProviderSummary,
  type ImportedModel,
  type MappedIosProvider,
} from "./iosProviderImport.js";

/**
 * [leo] 把解析好的 iOS 服务商写入 Mac 配置:走与界面新建相同的 Facade 操作
 * (createPersonalProvider / savePersonalProviderOverlay / addPersonalModel),逐个串行写入。
 */
function summarizeExisting(view: ProviderSettingsView): ExistingProviderSummary[] {
  return view.providers
    .filter((provider) => provider.effectiveConfig.access?.type !== "zhipu-account")
    .map((provider) => ({
      providerId: provider.providerId,
      label: provider.providerName?.trim() || provider.providerId,
      baseUrl: provider.effectiveConfig.api?.baseUrl ?? "",
    }));
}

export type ProviderImportTarget = Pick<
  ProviderSettingsFacade,
  | "getView"
  | "createPersonalProvider"
  | "savePersonalProviderOverlay"
  | "addPersonalModel"
  | "waitForProviderOperations"
>;

async function addModels(
  target: ProviderImportTarget,
  providerId: string,
  models: readonly ImportedModel[],
): Promise<number> {
  const provider = target.getView().providers.find((item) => item.providerId === providerId);
  const existing = new Set(provider?.models.map((model) => model.modelId) ?? []);
  let added = 0;
  // 同一 Provider 的成员写入串行,避免并发 add 基于同一份旧成员列表互相覆盖。
  for (const model of models) {
    if (existing.has(model.id)) continue;
    try {
      await target.addPersonalModel(
        providerId,
        model.id,
        buildRecommendedModelConfigPatch(model),
        true,
      );
      existing.add(model.id);
      added += 1;
    } catch {
      // 单个模型写入失败(如与内置模型重名)不影响其余模型和供应商本身。
    }
  }
  return added;
}

function stripMembership(config: ProviderConfigObject | undefined): ProviderConfigObject {
  const {
    builtinModelIds: _builtinModelIds,
    personalModelIds: _personalModelIds,
    ...rest
  } = config ?? {};
  return rest;
}

/** 执行导入:逐个写入,单项失败只影响该项。返回结果不含任何 Key。 */
export async function executeProviderImport(
  target: ProviderImportTarget,
  request: ProviderImportRequest,
): Promise<ProviderImportResult> {
  const items: ProviderImportItemResult[] = [];
  let providerBudget: number = PROVIDER_IMPORT_LIMITS.maxProviders;
  for (const file of request.files) {
    const parsed = parseIosProviderFile(file.name, file.content);
    for (const entry of parsed.entries) {
      const common = { fileName: file.name, label: entry.label, providerType: entry.providerType };
      if (entry.kind === "skipped") {
        items.push({
          ...common,
          status: "skipped",
          reason: entry.reason,
          ...(entry.detail ? { detail: entry.detail } : {}),
          needsKey: false,
          modelCount: 0,
        });
        continue;
      }
      if (providerBudget <= 0) {
        items.push({
          ...common,
          status: "skipped",
          reason: "too-many",
          needsKey: false,
          modelCount: 0,
        });
        continue;
      }
      providerBudget -= 1;
      try {
        items.push(await importOne(target, entry, common));
      } catch (error) {
        items.push({
          ...common,
          status: "skipped",
          reason: "failed",
          detail: error instanceof Error ? error.message : String(error),
          needsKey: false,
          modelCount: 0,
        });
      }
    }
  }
  return { items };
}

async function importOne(
  target: ProviderImportTarget,
  entry: MappedIosProvider,
  common: Pick<ProviderImportItemResult, "fileName" | "label" | "providerType">,
): Promise<ProviderImportItemResult> {
  const decision = decideImport(entry, summarizeExisting(target.getView()));
  const keyless = isKeylessLocalBaseUrl(entry.baseUrl);
  if (decision.action === "create") {
    const created = await target.createPersonalProvider({
      providerName: decision.label,
      initialConfig: {
        access: { type: "api-key", ...(entry.apiKey ? { apiKey: entry.apiKey } : {}) },
        api: {
          type: entry.apiType,
          baseUrl: entry.baseUrl,
          ...(entry.headers ? { headers: entry.headers } : {}),
        },
      },
    });
    const modelCount = await addModels(target, created.providerId, entry.models);
    return {
      ...common,
      label: decision.label,
      status: "imported",
      providerId: created.providerId,
      needsKey: !entry.apiKey && !keyless,
      modelCount,
    };
  }

  const providerId = decision.providerId;
  await target.waitForProviderOperations(providerId);
  const current = target.getView().providers.find((item) => item.providerId === providerId);
  const access = current?.effectiveConfig.access;
  const currentKey = access && access.type !== "zhipu-account" ? access.apiKey?.trim() : undefined;
  if (entry.apiKey && entry.apiKey !== currentKey && access?.type !== "zhipu-account") {
    const personal = stripMembership(current?.personalConfig);
    const personalAccess =
      personal.access && personal.access.type !== "zhipu-account" ? personal.access : undefined;
    await target.savePersonalProviderOverlay(providerId, {
      ...personal,
      access: { ...personalAccess, type: access?.type ?? "api-key", apiKey: entry.apiKey },
    });
  }
  const modelCount = await addModels(target, providerId, entry.models);
  return {
    ...common,
    status: "updated",
    providerId,
    needsKey: !entry.apiKey && !currentKey && !keyless,
    modelCount,
  };
}
