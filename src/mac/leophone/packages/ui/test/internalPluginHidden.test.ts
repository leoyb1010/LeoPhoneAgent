import assert from "node:assert/strict";
import test from "node:test";

import type { ZCodePluginInfo } from "@zcode/shared";
import { partitionPluginsForSettings } from "../src/settings/pluginCapabilityProjection.js";
import { buildStoreItems } from "../src/settings/pluginStoreListing.js";

const host = {
  id: "node-repl-host@zcode-plugins-official",
  name: "node-repl-host",
  marketplace: "zcode-plugins-official",
  source: "cache",
} as unknown as ZCodePluginInfo;
const browser = {
  id: "browser-use@zcode-plugins-official",
  name: "browser-use",
  marketplace: "zcode-plugins-official",
  source: "cache",
} as unknown as ZCodePluginInfo;

test("内部宿主插件不出现在设置页插件列表与插件市场", () => {
  const groups = partitionPluginsForSettings([host, browser], new Set([host.id, browser.id]));
  assert.deepEqual(
    groups.builtIn.map((p) => p.id),
    [browser.id],
  );
  assert.deepEqual(groups.installed, []);
  const items = buildStoreItems({
    marketplaces: [],
    marketplaceAvailabilityKnown: false,
    availablePlugins: [],
    installedPlugins: [],
    plugins: [host, browser],
    restorableBuiltins: [],
  });
  assert.deepEqual(
    items.map((item) => item.id),
    [browser.id],
  );
});
