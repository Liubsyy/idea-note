import { defineConfig, mergeConfig, type Plugin } from "vite";
import appConfig from "../vite.config";

// Test-only latency. The application and native resource protocol have no delay.
const slowResources: Plugin = {
  name: "preview-loading-fixtures",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/tests/preview-fixtures/assets/slow.js") return next();
      const wait = Math.min(10000, Math.max(0, Number(url.searchParams.get("delay")) || 1800));
      res.setHeader("Cache-Control", "no-store");
      const timer = setTimeout(() => { if (!res.destroyed) next(); }, wait);
      res.on("close", () => clearTimeout(timer));
    });
  },
};
export default defineConfig(async env => mergeConfig(
  typeof appConfig === "function" ? await appConfig(env) : await appConfig,
  { plugins: [slowResources] },
));
