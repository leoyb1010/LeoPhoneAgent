import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  LEO_NO_PROXY,
  LEO_PROXY_MARKER,
  parseScutilProxy,
  setSystemProxyEnabled,
  systemProxyAdditions,
  systemProxyEnabled,
  withSystemProxy,
} from "../src/system-proxy.js";

// [fix-remote] Clash 系统代理 → 外部 agent / 内核 CLI 的 HTTP(S)_PROXY。
const CLASH = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7890
  SOCKSProxy : 127.0.0.1
}`;

describe("system proxy", () => {
  it("parses scutil --proxy, only enabled entries", () => {
    expect(parseScutilProxy(CLASH)).toEqual({
      http: "http://127.0.0.1:7897",
      https: "http://127.0.0.1:7897",
      socks: "socks5://127.0.0.1:7890",
    });
    expect(parseScutilProxy(CLASH.replace("HTTPSEnable : 1", "HTTPSEnable : 0").replace("SOCKSEnable : 1", "SOCKSEnable : 0"))).toEqual({
      http: "http://127.0.0.1:7897",
    });
    expect(parseScutilProxy("<dictionary> {\n  HTTPEnable : 0\n}")).toEqual({});
  });

  it("injects HTTP(S)/ALL proxy and NO_PROXY when the env has none", () => {
    const env = withSystemProxy({ PATH: "/usr/bin", HOME: mkdtempSync(join(tmpdir(), "leo-proxy-")) }, { enabled: true, proxy: parseScutilProxy(CLASH) });
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
    expect(env.https_proxy).toBe("http://127.0.0.1:7897");
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7897");
    expect(env.ALL_PROXY).toBe("socks5://127.0.0.1:7890");
    expect(env.NO_PROXY).toBe(LEO_NO_PROXY);
    expect(LEO_NO_PROXY.split(",")).toEqual(
      expect.arrayContaining(["localhost", "127.0.0.1", "::1", ".local", "100.64.0.0/10", ".ts.net", "*.ts.net"]),
    );
  });

  it("NO_PROXY takes the relay hosts from ~/.leoagent/relay.json instead of a hard-coded domain", () => {
    const home = mkdtempSync(join(tmpdir(), "leo-proxy-"));
    const leoHome = join(home, ".leoagent");
    mkdirSync(leoHome);
    writeFileSync(
      join(leoHome, "relay.json"),
      JSON.stringify({ url: "https://relay.example.org", key: "k", phone_urls: ["wss://edge.example.net/relay", "bad url"] }),
    );
    const env = withSystemProxy({ HOME: home }, { enabled: true, proxy: parseScutilProxy(CLASH) });
    expect(env.NO_PROXY).toBe(`${LEO_NO_PROXY},relay.example.org,edge.example.net`);
    expect(LEO_NO_PROXY).not.toContain("leoyuan");
  });

  it("re-reads the system proxy for an env we injected before (Clash switched port / quit)", () => {
    const home = mkdtempSync(join(tmpdir(), "leo-proxy-"));
    const first = withSystemProxy({ PATH: "/bin", HOME: home }, { enabled: true, proxy: parseScutilProxy(CLASH) });
    expect(first[LEO_PROXY_MARKER]).toBe("1");
    const moved = withSystemProxy(first, { enabled: true, proxy: { http: "http://127.0.0.1:9999" } });
    expect(moved.HTTPS_PROXY).toBe("http://127.0.0.1:9999");
    expect(moved.ALL_PROXY).toBe("http://127.0.0.1:9999");
    expect(moved.NO_PROXY).toBe(LEO_NO_PROXY);
    // 系统代理关了：撤得干干净净
    expect(withSystemProxy(first, { enabled: true, proxy: {} })).toEqual({ PATH: "/bin", HOME: home });
    // 用户自己的 NO_PROXY 不被撤
    const mine = withSystemProxy({ HOME: home, NO_PROXY: "corp.internal" }, { enabled: true, proxy: parseScutilProxy(CLASH) });
    expect(withSystemProxy(mine, { enabled: true, proxy: {} })).toEqual({ HOME: home, NO_PROXY: "corp.internal" });
  });

  it("never overrides a proxy the user already set, nor their NO_PROXY", () => {
    const mine = { HTTPS_PROXY: "http://corp:3128", NO_PROXY: "corp.internal" };
    expect(withSystemProxy(mine, { enabled: true, proxy: parseScutilProxy(CLASH) })).toEqual(mine);
    expect(systemProxyAdditions({ https_proxy: "http://x:1" }, { enabled: true, proxy: parseScutilProxy(CLASH) })).toEqual({});
    const keepNoProxy = withSystemProxy({ no_proxy: "a.b" }, { enabled: true, proxy: parseScutilProxy(CLASH) });
    expect(keepNoProxy.no_proxy).toBe("a.b");
    expect(keepNoProxy.NO_PROXY).toBeUndefined();
  });

  it("switch off: nothing injected, and a previously injected env is cleaned up", () => {
    expect(withSystemProxy({ PATH: "/bin" }, { enabled: false, proxy: parseScutilProxy(CLASH) })).toEqual({ PATH: "/bin" });
    const home = mkdtempSync(join(tmpdir(), "leo-proxy-"));
    const injected = withSystemProxy({ PATH: "/bin", HOME: home }, { enabled: true, proxy: parseScutilProxy(CLASH) });
    expect(withSystemProxy(injected, { enabled: false })).toEqual({ PATH: "/bin", HOME: home });
  });

  it("the setting defaults on and persists under the data root", () => {
    const env = { HOME: mkdtempSync(join(tmpdir(), "leo-proxy-")) };
    expect(systemProxyEnabled(env)).toBe(true);
    setSystemProxyEnabled(false, env);
    expect(systemProxyEnabled(env)).toBe(false);
    setSystemProxyEnabled(true, env);
    expect(systemProxyEnabled(env)).toBe(true);
    expect(systemProxyEnabled({ ...env, LEO_SYSTEM_PROXY: "off" })).toBe(false);
  });
});
