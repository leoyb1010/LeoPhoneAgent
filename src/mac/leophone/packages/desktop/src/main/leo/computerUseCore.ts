/**
 * [leo][WP-22] 设置「我的设备 → 电脑操作」:解析 `peekaboo permissions status --json`。
 * macOS 27 读不到 TCC.db,权限状态只能问 Peekaboo 自己(它按 LeoBot 的签名身份去问系统)。
 */

export type ComputerUsePermissionKey = "screen-recording" | "accessibility" | "event-synthesizing";

export interface ComputerUsePermission {
  key: ComputerUsePermissionKey;
  name: string;
  required: boolean;
  granted: boolean;
  instructions: string;
}

export type ComputerUseStatus =
  | {
      state: "ok";
      version: string | null;
      permissions: ComputerUsePermission[];
      source: string | null;
    }
  | { state: "missing" }
  | { state: "error"; message: string };

const KEY_BY_NAME: Record<string, ComputerUsePermissionKey> = {
  "screen recording": "screen-recording",
  accessibility: "accessibility",
  "event synthesizing": "event-synthesizing",
};

/** 系统设置里对应的隐私面板(「去系统设置」按钮直达)。 */
export const PRIVACY_PANE_URL: Record<ComputerUsePermissionKey, string> = {
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "event-synthesizing":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

export function parsePeekabooPermissions(stdout: string): ComputerUseStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { state: "error", message: "Peekaboo 返回的不是 JSON" };
  }
  const root = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const data =
    root["data"] && typeof root["data"] === "object"
      ? (root["data"] as Record<string, unknown>)
      : {};
  if (root["success"] !== true || !Array.isArray(data["permissions"])) {
    const error = root["error"] as { message?: unknown } | undefined;
    return {
      state: "error",
      message: typeof error?.message === "string" ? error.message : "Peekaboo 没有返回权限列表",
    };
  }
  const permissions: ComputerUsePermission[] = [];
  for (const raw of data["permissions"] as unknown[]) {
    const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const name = typeof item["name"] === "string" ? item["name"] : "";
    const key = KEY_BY_NAME[name.toLowerCase()];
    if (!key) continue;
    permissions.push({
      key,
      name,
      required: item["isRequired"] === true,
      granted: item["isGranted"] === true,
      instructions: typeof item["grantInstructions"] === "string" ? item["grantInstructions"] : "",
    });
  }
  return {
    state: "ok",
    version: null,
    permissions,
    source: typeof data["source"] === "string" ? data["source"] : null,
  };
}
