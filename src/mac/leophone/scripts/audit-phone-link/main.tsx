// Isolated audit fixture: production components, synthetic bridge, no real credentials or network.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  LeoPhoneLinkSection,
  type LeoLinkBridge,
  type LinkStatus,
} from "../../packages/ui/src/leo/LeoPhoneLinkSection.js";
import "../../packages/ui/src/styles.css";
import "../../packages/ui/src/leo/skin/leo-skin.css";
const pending: Array<() => void> = [];
const active = new Set<string>();
let serial = 0,
  revoked = 0,
  failures = false,
  revokeFailure = false;
let refresh = () => {};
const status: LinkStatus = {
  enabled: true,
  configured: true,
  running: true,
  connected: true,
  pairing: "supported",
  machine: "Synthetic Mac",
  relayHost: "fixture.invalid",
  relayVersion: "0.2",
  lastError: null,
  direct: {
    running: true,
    deviceId: "synthetic-device",
    baseURL: "https://fixture.synthetic.ts.net",
    port: 38474,
    error: null,
    syncEnabled: false,
    treasuryEnabled: false,
    devices: [],
  },
};
const pair: LeoLinkBridge["pair"] = () =>
  new Promise((resolve) => {
    pending.push(() => {
      const payload = "synthetic-audit-only-" + ++serial;
      active.add(payload);
      resolve({
        ok: true,
        data: { payload, machine: "Synthetic Mac", exp: Date.now() / 1000 + 300 },
      });
      refresh();
    });
    refresh();
  });
window.leoLink = {
  status: async () => {
    if (failures) throw new Error("Synthetic IPC offline");
    return { ok: true, data: structuredClone(status) };
  },
  pair,
  revoke: async (payload: string) => {
    if (revokeFailure) return { ok: false, error: "Synthetic revocation unavailable" };
    active.delete(payload);
    revoked++;
    refresh();
    return { ok: true, data: null };
  },
  direct: async (action: string, body: unknown) => {
    if (action === "pair") return pair();
    if (action === "configure") {
      const value = body as {
        enabled: boolean;
        baseURL: string;
        port: number;
        syncEnabled: boolean;
        treasuryEnabled: boolean;
      };
      if (
        value.enabled &&
        (!/^https:\/\/[^/]+\.ts\.net$/.test(value.baseURL) ||
          !Number.isInteger(value.port) ||
          value.port < 1024 ||
          value.port > 65535)
      )
        return { ok: false, error: "Invalid synthetic direct configuration" };
      localStorage.setItem("leo-audit-direct", JSON.stringify(value));
      status.direct = { ...status.direct!, running: value.enabled, ...value };
    }
    refresh();
    return { ok: true, data: { payload: "", machine: "", exp: 0 } };
  },
} as LeoLinkBridge;
function Fixture() {
  const [open, setOpen] = useState(true);
  const [, setTick] = useState(0);
  refresh = () => setTick((t) => t + 1);
  return (
    <main
      className="mx-auto max-w-3xl space-y-4 p-6 text-ui-base text-foreground"
      style={{ height: "100vh", overflow: "auto", background: "var(--color-background)" }}
    >
      <h1 className="text-ui-xl">LeoPhoneAgent 配对流程 · 隔离测试</h1>
      <p>真实产品组件；模拟本地桥接，不连接任何真实设备、账户或中继</p>
      <div className="flex flex-wrap gap-3">
        <button onClick={() => setOpen(!open)}>{open ? "关闭面板" : "打开面板"}</button>
        <button
          onClick={() => {
            pending.shift()?.();
            refresh();
          }}
        >
          完成待发配对请求
        </button>
        <button
          onClick={() => {
            failures = !failures;
            refresh();
          }}
        >
          状态错误：{failures ? "开" : "关"}
        </button>
        <button
          onClick={() => {
            revokeFailure = !revokeFailure;
            refresh();
          }}
        >
          撤销错误：{revokeFailure ? "开" : "关"}
        </button>
        <button
          onClick={() => {
            document.documentElement.classList.toggle("theme-zai-dark");
            document.documentElement.classList.toggle("theme-zai-light");
          }}
        >
          切换深浅主题
        </button>
      </div>
      <p role="status">
        待发 {pending.length} · 已签发 {serial} · 未撤销 {active.size} · 已撤销 {revoked}
      </p>
      {open ? <LeoPhoneLinkSection /> : <p>面板已关闭</p>}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
