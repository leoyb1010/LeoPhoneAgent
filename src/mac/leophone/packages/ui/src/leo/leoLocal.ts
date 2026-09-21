import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";

/**
 * [leo] 本机 Leo 服务(host 进程里的 127.0.0.1 小服务)的入口地址。
 * 订阅账号(Claude / ChatGPT / Copilot 等)登录页在系统浏览器里打开,凭据只存在本机 ~/.leoagent/oauth。
 */
export const LEO_LOCAL_ORIGIN = "http://127.0.0.1:38473";
export const LEO_OAUTH_PAGE_URL = `${LEO_LOCAL_ORIGIN}/leo/oauth`;

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
