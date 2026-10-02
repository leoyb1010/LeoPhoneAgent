import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "../../packages/ui/src"),
      "@zcode/shared": resolve(__dirname, "../../packages/shared/src/log-format.ts"),
    },
  },
  server: { host: "127.0.0.1", port: 5177, strictPort: true },
});
