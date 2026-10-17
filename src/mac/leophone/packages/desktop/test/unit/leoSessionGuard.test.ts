import { expect, it, vi } from "vitest";
import type { OnBeforeRequestListenerDetails } from "electron";

vi.mock("electron", () => ({ session: { defaultSession: { webRequest: {} } }, webContents: {} }));

import { blockBeforeRequest, subscribeBeforeRequest } from "../../src/main/observeBeforeRequest.js";
import { isLeoBlockedRequest, LEO_SESSION_GUARD_URLS } from "../../src/main/leoSessionGuard.js";

type Listener = (
  details: OnBeforeRequestListenerDetails,
  callback: (response: { cancel?: boolean }) => void,
) => void;

function createSource() {
  let listener: Listener | null = null;
  const onBeforeRequest = vi.fn((filter: unknown, next?: Listener) => {
    listener = filter === null ? null : (next ?? null);
  });
  const fire = (url: string) => {
    const callback = vi.fn();
    listener?.({ url } as OnBeforeRequestListenerDetails, callback);
    return { installed: listener !== null, callback };
  };
  return { webRequest: { onBeforeRequest }, onBeforeRequest, fire };
}

it("[leo] 官方域名(含 codegeex)被取消，其余放行", () => {
  for (const url of [
    "https://zcode.z.ai/api/v1/x",
    "wss://zcode.z.ai/ws",
    "https://open.bigmodel.cn/api/anthropic",
    "https://z-cdn.chatglm.cn/office-skill/fonts",
    "https://cdn.codegeex.cn/zcode/electron/releases",
    "https://api.zhipuai.cn/",
  ]) {
    expect(isLeoBlockedRequest({ url }), url).toBe(true);
  }
  for (const url of ["https://api.openai.com/v1", "https://baz.ai/", "http://127.0.0.1:9/x"]) {
    expect(isLeoBlockedRequest({ url }), url).toBe(false);
  }
});

it("[leo] 资源管理器抓包开 / 关之后拦截仍然生效", () => {
  const source = createSource();
  blockBeforeRequest(source.webRequest, LEO_SESSION_GUARD_URLS, isLeoBlockedRequest);
  expect(source.fire("https://zcode.z.ai/a").callback).toHaveBeenCalledWith({ cancel: true });

  // 抓包开始：观测者登记到同一分发入口，被拦的请求照样取消，且观测者能看到它。
  const observed: string[] = [];
  const stopCapture = subscribeBeforeRequest(source.webRequest, ["https://*/*"], (details) =>
    observed.push(details.url),
  );
  expect(source.fire("https://chat.z.ai/b").callback).toHaveBeenCalledWith({ cancel: true });
  expect(source.fire("https://example.test/c").callback).toHaveBeenCalledWith({});
  expect(observed).toEqual(["https://chat.z.ai/b", "https://example.test/c"]);

  // 抓包停止：上游原实现会 onBeforeRequest(null) 清掉监听；有拦截者时监听必须还在。
  stopCapture();
  expect(source.onBeforeRequest).not.toHaveBeenLastCalledWith(null);
  const after = source.fire("https://cdn.codegeex.cn/x");
  expect(after.installed).toBe(true);
  expect(after.callback).toHaveBeenCalledWith({ cancel: true });
});

it("[leo] 拦截者全部注销且没有观测者时才清除监听", () => {
  const source = createSource();
  const unblock = blockBeforeRequest(source.webRequest, LEO_SESSION_GUARD_URLS, isLeoBlockedRequest);
  unblock();
  expect(source.onBeforeRequest).toHaveBeenLastCalledWith(null);
});
