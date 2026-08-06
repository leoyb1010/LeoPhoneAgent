import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { injectMobileEndpointsIntoEasFile } from '../../scripts/mobile-endpoints.mjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('EAS endpoint injection', () => {
  it('temporarily injects all build profiles and restores the original bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'mobile-eas-endpoints-'));
    roots.push(root);
    const easPath = join(root, 'eas.json');
    const original = '{\n  "build": { "production": { "env": { "KEEP": "1" } }, "beta": { "extends": "production" } }\n}\n';
    writeFileSync(easPath, original);

    const endpointEnv = {
      EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn',
      EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: 'https://hotfix.example.invalid/app',
    };
    const restore = injectMobileEndpointsIntoEasFile(easPath, { endpointEnv });
    const injected = JSON.parse(readFileSync(easPath, 'utf8'));
    expect(injected.build.production.env).toMatchObject({ KEEP: '1', ...endpointEnv });
    expect(injected.build.beta.env).toEqual(endpointEnv);

    restore();
    restore();
    expect(readFileSync(easPath, 'utf8')).toBe(original);
  });

  it('selects the auth endpoint from each profile inherited region', () => {
    const root = mkdtempSync(join(tmpdir(), 'mobile-eas-regions-'));
    roots.push(root);
    const easPath = join(root, 'eas.json');
    writeFileSync(easPath, JSON.stringify({
      build: {
        cn: { env: { EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn' } },
        global: { env: { EXPO_PUBLIC_CINDY_AUTH_REGION: 'global' } },
        'global-child': { extends: 'global' },
      },
    }));
    const common = {
      EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: 'https://hotfix.example.invalid/app',
    };
    const endpointEnvByRegion = {
      cn: {
        ...common,
        EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn',
        EXPO_PUBLIC_CINDY_AUTH_BASE_URL: 'https://auth-cn.example.invalid',
      },
      global: {
        ...common,
        EXPO_PUBLIC_CINDY_AUTH_REGION: 'global',
        EXPO_PUBLIC_CINDY_AUTH_BASE_URL: 'https://auth-global.example.invalid',
      },
    };

    injectMobileEndpointsIntoEasFile(easPath, { endpointEnvByRegion });
    const injected = JSON.parse(readFileSync(easPath, 'utf8'));
    expect(injected.build.cn.env.EXPO_PUBLIC_CINDY_AUTH_BASE_URL).toBe(
      endpointEnvByRegion.cn.EXPO_PUBLIC_CINDY_AUTH_BASE_URL,
    );
    expect(injected.build.global.env.EXPO_PUBLIC_CINDY_AUTH_BASE_URL).toBe(
      endpointEnvByRegion.global.EXPO_PUBLIC_CINDY_AUTH_BASE_URL,
    );
    expect(injected.build['global-child'].env.EXPO_PUBLIC_CINDY_AUTH_BASE_URL).toBe(
      endpointEnvByRegion.global.EXPO_PUBLIC_CINDY_AUTH_BASE_URL,
    );
  });

  it('reaps a stale reclaim marker before recovering a stale lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'mobile-eas-stale-reclaim-'));
    roots.push(root);
    const easPath = join(root, 'eas.json');
    const original = '{"build":{"production":{}}}\n';
    writeFileSync(easPath, original);

    const lockPath = `${easPath}.xdt-lock`;
    const reclaimPath = `${lockPath}.reclaim`;
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      `${lockPath}/owner.json`,
      JSON.stringify({ pid: 999_999_999, token: 'stale-lock', createdAt: 0 }),
    );
    mkdirSync(reclaimPath, { recursive: true });
    writeFileSync(
      `${reclaimPath}/owner.json`,
      // Use the current PID to cover PID reuse / false-liveness detection.
      JSON.stringify({ pid: process.pid, token: 'stale-reclaim', createdAt: 0 }),
    );

    const restore = injectMobileEndpointsIntoEasFile(easPath, {
      endpointEnv: { EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: 'https://hotfix.example.invalid/app' },
    });
    expect(readFileSync(easPath, 'utf8')).not.toBe(original);
    restore();
    expect(readFileSync(easPath, 'utf8')).toBe(original);
    expect(() => readFileSync(reclaimPath)).toThrow();
  });
});
