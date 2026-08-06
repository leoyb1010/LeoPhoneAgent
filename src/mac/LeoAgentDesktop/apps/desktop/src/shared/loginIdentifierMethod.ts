/**
 * loginIdentifierMethod — 登录 identifier 形态的确定性解析(用户拍板 2026-07-21)。
 *
 * 手机号与邮箱登录按构建区域分区互斥:cn=手机号、global=邮箱(dev 随
 * resolveCindyRegion 回落 cn)。双 tab 切换 UI 已按该拍板整体移除——即使
 * 服务端误下发两种方式也不再并列呈现,一律取区域首选;服务端 providers
 * 仅作缺失兜底(区域首选方式未下发时落到另一侧的单形态)。
 */
import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

/** providers 中与 identifier 形态相关的开关位(auth-client LoginProviders 子集)。 */
export interface IdentifierProviderFlags {
  email: boolean;
  phone: boolean;
}

export type IdentifierMethod = 'email' | 'phone';

/** 区域 → identifier 形态;providers 仅兜底缺失,永不产生双形态。 */
export function resolveIdentifierMethod(
  region: CindyRegion,
  providers: IdentifierProviderFlags,
): IdentifierMethod {
  const preferred: IdentifierMethod = region === 'global' ? 'email' : 'phone';
  const fallback: IdentifierMethod = preferred === 'email' ? 'phone' : 'email';
  if (providers[preferred]) return preferred;
  if (providers[fallback]) return fallback;
  return preferred;
}
