import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";


test("模型失败的英文兜底句按 code 本地化，带具体原因的消息保持原文", async () => {
  const { resolveChatErrorBannerDisplayMessage } = await import("../src/ChatErrorBanner.js");
  const intl = { formatMessage: ({ id }: { id: string }) => `[${id}]` } as never;
  const err = (message: string) =>
    ({ code: "model_request_failed", message }) as Parameters<
      typeof resolveChatErrorBannerDisplayMessage
    >[0];
  assert.equal(
    resolveChatErrorBannerDisplayMessage(err("Model request failed."), intl),
    "[chat.error.modelRequestFailed]",
  );
  assert.equal(
    resolveChatErrorBannerDisplayMessage(
      err("Network connection failed for the provider request."),
      intl,
    ),
    "[chat.error.modelNetworkFailed]",
  );
  assert.equal(
    resolveChatErrorBannerDisplayMessage(err("401 invalid api key"), intl),
    "401 invalid api key",
  );
});
