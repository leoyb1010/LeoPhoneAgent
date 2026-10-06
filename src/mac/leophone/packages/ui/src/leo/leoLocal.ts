import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";

type OAuthOpenResult = { ok: true } | { ok: false; error: string };

/**
 * [leo] 订阅账号(ChatGPT / Copilot / OpenCode Go 等)登录页:由本机 Leo 服务提供,在系统浏览器里打开,
 * 凭据只存在本机 ~/.leoagent/oauth。地址由主进程拼:端口按实际配置,并带上本次启动的口令
 * (登录 / 退出接口只认它);界面里不写死地址。
 */
export async function openLeoOAuthPage(): Promise<void> {
  const bridge = (window as unknown as { leoLink?: { openOAuthPage?: () => Promise<OAuthOpenResult> } })
    .leoLink;
  if (!bridge?.openOAuthPage) return;
  const result = await bridge.openOAuthPage().catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  }));
  if (!result.ok) window.alert(`打不开订阅账号登录页：${result.error}`);
}

const OPEN_MODEL_SETTINGS_AFTER_WELCOME_KEY = "leo.openModelSettingsAfterWelcome";

/** 欢迎页选「用 API Key 添加模型供应商」:进入主界面后直接打开设置 → 模型供应商。 */
export function requestModelSettingsAfterWelcome(): void {
  setPendingSettingsSectionIntent("modelProvider");
  try {
    window.sessionStorage.setItem(OPEN_MODEL_SETTINGS_AFTER_WELCOME_KEY, "1");
  } catch {
    // 存不了就只是不自动跳转,用户仍可从「设置模型」进入。
  }
}

export function consumeModelSettingsAfterWelcome(): boolean {
  try {
    const requested = window.sessionStorage.getItem(OPEN_MODEL_SETTINGS_AFTER_WELCOME_KEY) === "1";
    window.sessionStorage.removeItem(OPEN_MODEL_SETTINGS_AFTER_WELCOME_KEY);
    return requested;
  } catch {
    return false;
  }
}
