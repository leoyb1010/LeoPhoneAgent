// [leo] 测试 HOME 隔离 + 真实用户数据写入守卫（scripts/test-isolation/home.mjs）。
import { defineConfig } from "vitest/config";
import { leoTestIsolation } from "../../../../scripts/test-isolation/vitest.mjs";

export default defineConfig({ test: leoTestIsolation() });
