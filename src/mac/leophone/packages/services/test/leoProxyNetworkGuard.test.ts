import assert from "node:assert/strict";
import test from "node:test";

import { createHostApiNetworkTransport } from "../src/providers/api/nodeApiNetwork.js";

test("blocked official hosts are refused even when the request would go through a proxy", async () => {
  let dispatched = 0;
  const transport = createHostApiNetworkTransport(
    async () => ({ httpProxy: "http://127.0.0.1:7890" }),
    {
      createDispatcher: async () => ({}) as never,
      fetchWithDispatcher: async () => {
        dispatched++;
        return new Response("{}");
      },
    },
  );
  // 走代理时目标域名不经本机 DNS,DNS 层的闸门拦不到。
  await assert.rejects(transport.fetch("https://open.bigmodel.cn/api/paas/v4/models"), /不连接/);
  await assert.rejects(transport.fetch("https://api.z.ai/v1"), /不连接/);
  assert.equal(dispatched, 0);
  await transport.fetch("https://api.openai.com/v1/models");
  assert.equal(dispatched, 1);
  transport.dispose();
});
