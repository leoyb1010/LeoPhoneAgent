/**
 * marketAccess — Skill Hub 市场(浏览入口 / 推荐安装 / market 路由)的可见性门禁。
 *
 * 市场当前是 xd 组织的内部市场:仅 xd 组织的企业(org)成员可见。
 * 个人账号、非 xd 组织的企业账号、未登录 / 登录态未就绪一律不可见(fail-closed),
 * 技能页只保留本地技能管理。
 *
 * 判据:主判据是 `orgSlug`(access token 的 orgSlug claim,auth-server 由已验证
 * 域名派生、全局唯一,xd.com → 'xd');orgId 是 cuid、orgName 是可重名的显示名,
 * 都不适合当配置键。仅当 orgSlug 缺失(旧版 auth-server token 无此 claim)时,
 * 才回退用 orgName 全等匹配兜底。
 */

/** 允许访问市场的组织 slug。 */
const SKILLHUB_MARKET_ORG_SLUG = 'xd';

interface MarketAccessUser {
  membershipKind: 'personal' | 'org';
  orgName: string | null;
  orgSlug: string | null;
}

/** 当前登录用户是否可见 Skill Hub 市场内容(null = 未登录,按不可见处理)。 */
export function canAccessSkillhubMarket(user: MarketAccessUser | null): boolean {
  if (!user || user.membershipKind !== 'org') return false;
  if (user.orgSlug !== null) return user.orgSlug === SKILLHUB_MARKET_ORG_SLUG;
  // 旧 token 无 orgSlug claim 的兜底:显示名全等匹配(大小写不敏感)。
  return (
    user.orgName !== null &&
    user.orgName.trim().toLocaleLowerCase() === SKILLHUB_MARKET_ORG_SLUG
  );
}
