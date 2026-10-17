// [leo] 测试 HOME 隔离 + 真实用户数据写入守卫（scripts/test-isolation/home.mjs）；其余沿用 vite.config.ts。
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";
import { leoTestIsolation } from "../../../../scripts/test-isolation/vitest.mjs";

export default mergeConfig(viteConfig, defineConfig({ test: leoTestIsolation() }));
