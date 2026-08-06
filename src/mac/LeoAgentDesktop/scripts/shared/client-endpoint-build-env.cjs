/**
 * app.config.js 使用的 CommonJS 端点自举加载器。
 * 与 client-endpoint-build-env.mjs 的 mobileClientBuildEnv 保持同一输出契约。
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function resolveRegion(value) {
  const region = value?.trim() || 'cn';
  if (region !== 'cn' && region !== 'global' && region !== 'dev') {
    throw new Error(`Invalid Cindy auth region: ${region}; expected cn, global or dev`);
  }
  return region;
}

function loadMobileClientBuildEnv() {
  const region = resolveRegion(process.env.EXPO_PUBLIC_CINDY_AUTH_REGION);
  const manifestPath = path.join(
    REPO_ROOT,
    'config',
    { cn: 'endpoint.json', global: 'endpoint.global.json', dev: 'endpoint.dev.json' }[region],
  );
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`缺少 ${region} 客户端端点清单: ${manifestPath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`客户端端点清单不是合法 JSON: ${manifestPath}`);
    }
    throw error;
  }
  if (!Number.isInteger(parsed?.schemaVersion) || parsed.schemaVersion < 1) {
    throw new Error(`客户端端点清单 schemaVersion 非法: ${manifestPath}`);
  }
  const raw = parsed?.cdnBaseUrl;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`客户端端点清单缺少非空字段 cdnBaseUrl: ${manifestPath}`);
  }
  const normalized = raw.trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`客户端端点清单字段 cdnBaseUrl 不是合法绝对 URL: ${manifestPath}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`客户端端点清单字段 cdnBaseUrl 必须是无凭据 HTTPS URL: ${manifestPath}`);
  }
  return Object.freeze({
    EXPO_PUBLIC_CINDY_AUTH_REGION: region,
    EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: normalized,
  });
}

module.exports = { loadMobileClientBuildEnv };
