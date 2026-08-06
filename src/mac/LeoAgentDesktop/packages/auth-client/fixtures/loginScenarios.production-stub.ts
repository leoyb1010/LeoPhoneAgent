/**
 * 登录 scenario fixtures 的生产构建空 stub(PR0a,生产排除双保险第 2 层)。
 *
 * 生产构建经 bundler 条件(desktop vite alias / mobile metro resolveRequest)
 * 把 `loginScenarios.ts` 整模块替换为本文件——fixtures 代码与 sentinel 字符串
 * 都不进生产产物;`scripts/check-login-production-guard.mjs` 以 sentinel 双断言
 * 校验替换生效。API 表面与真模块一致(TS 层可替换),行为全部惰化:
 * guard 恒 null,其余入口直接抛错(生产路径不可达,规则 12「fail visibly」)。
 *
 * 注意:本文件**不得**出现真 sentinel 字符串字面量。
 */

import type { AuthFetch } from "../src/client.js";
import type { AuthRegion } from "../src/types.js";
import type {
  LoginScenarioErrorEndpoint,
  ParsedLoginScenario,
} from "./loginScenarios.js";

/** 生产 stub:空串,绝不等于真 sentinel。 */
export const CINDY_LOGIN_FIXTURE_SENTINEL = "";

export const LOGIN_SCENARIO_TOKENS = Object.freeze([] as const);
export const LOGIN_SCENARIO_ERROR_ENDPOINTS = Object.freeze([] as const);
export const LOGIN_SCENARIO_ERROR_CODES = Object.freeze([] as const);
export type { LoginScenarioErrorEndpoint, ParsedLoginScenario };

function unavailable(): never {
  throw new Error("login scenario fixtures are excluded from production builds");
}

export function parseLoginScenario(_raw: string): ParsedLoginScenario {
  return unavailable();
}

export function createScenarioFetch(
  _rawScenario: string,
  _opts: { region: AuthRegion },
): AuthFetch {
  return unavailable();
}

export function createMalformedResponseFetch(
  _endpoint: LoginScenarioErrorEndpoint,
  _opts: { region: AuthRegion },
): AuthFetch {
  return unavailable();
}

/** 生产构建下 harness 永远失效:恒 null,不抛错(该函数在正常路径被调用)。 */
export function resolveLoginScenarioFetch(_input: {
  devModeActive: boolean;
  scenario: string | undefined | null;
  region: AuthRegion;
}): AuthFetch | null {
  return null;
}
