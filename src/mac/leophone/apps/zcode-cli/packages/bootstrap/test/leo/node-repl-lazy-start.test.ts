// [leo] 内置 node_repl 按需启动(同步上游把 leoLazyStart 冲掉会红):每个 workspace 常驻约 200 MB,
// 多数会话用不到浏览器 / 电脑操作,连上列完工具就停,首次调用再拉起(见 adapters/test/leo/mcp-lazy-start)。

import assert from "node:assert/strict";
import test from "node:test";

import { resolveBuiltInNodeReplMcpServers } from "../../src/app/built-in-node-repl.js";

const plugin = (id: string, rootPath: string) => ({ id, enabled: true, rootPath }) as never;

test("built-in node_repl is registered with leoLazyStart", () => {
  const servers = resolveBuiltInNodeReplMcpServers({
    pluginOutcome: {
      plugins: [
        plugin("node-repl-host@zcode-plugins-official", "/tmp/host"),
        plugin("browser-use@zcode-plugins-official", "/tmp/browser-use"),
      ],
    },
    workingDirectory: "/workspace",
  });
  assert.equal(servers["node_repl"]?.type, "stdio");
  assert.equal(servers["node_repl"]?.leoLazyStart, true);
});
