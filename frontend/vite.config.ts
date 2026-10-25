import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Dev-only: proxy /api to the admin API so the browser stays same-origin
  // (the admin API does not send CORS headers). Never bundled into the build.
  const target = env.STREAMWORKER_ADMIN_URL;
  return {
    base: "./",
    plugins: [react()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: target
      ? { proxy: { "/api": { target, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") } } }
      : {},
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      css: false,
    },
  };
});
