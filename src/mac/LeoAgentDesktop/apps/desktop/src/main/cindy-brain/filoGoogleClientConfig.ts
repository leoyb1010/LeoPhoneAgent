import type { GhostManifest } from '../../shared/ghost.js';
import { FILO_GOOGLE_GHOST_ID, FILO_GOOGLE_SECRET_KEY } from './googleAccountsMigration.js';

/**
 * Filo Google 的 OAuth client 随插件清单分发（desktop 类 client 凭证按
 * Google 口径非机密，2026-07 维护者拍板回填 ghost.json）。本模块保留构建
 * 环境覆写通道：.env / 发布环境注入时优先于清单值，只在 main 内存里的出网
 * 声明上补值，不改磁盘 manifest，也不把覆写值广播给 renderer。
 */
export interface FiloGoogleBuildClientConfig {
  clientId?: string;
  clientSecret?: string;
}

/** 给 main 内部使用的 Filo Google manifest 补上构建环境里的 OAuth client。 */
export function withFiloGoogleBuildClientConfig(
  manifest: GhostManifest,
  config: FiloGoogleBuildClientConfig,
): GhostManifest {
  const clientId = config.clientId?.trim();
  if (manifest.id !== FILO_GOOGLE_GHOST_ID || !clientId || !manifest.network) return manifest;

  let changed = false;
  const clientSecret = config.clientSecret?.trim();
  const secrets = manifest.network.secrets?.map((secret) => {
    if (
      secret.key !== FILO_GOOGLE_SECRET_KEY ||
      secret.source !== 'oauth' ||
      !secret.oauth
    ) {
      return secret;
    }
    changed = true;
    const oauth = { ...secret.oauth, clientId };
    delete oauth.clientSecret;
    if (clientSecret) oauth.clientSecret = clientSecret;
    return {
      ...secret,
      oauth,
    };
  });
  if (!changed || !secrets) return manifest;
  return { ...manifest, network: { ...manifest.network, secrets } };
}
