import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const isWindowsTarget = process.env.TAURI_ENV_PLATFORM === "windows";

// WKWebView（及所有现代浏览器）只会取 woff2，KaTeX 同捆的 ttf/woff 永远不会被请求。
// 在产物里剔除这 40 个死重量文件（约 700KB），只保留 woff2。
const dropKatexLegacyFonts = {
  name: "drop-katex-legacy-fonts",
  generateBundle(_options: unknown, bundle: Record<string, unknown>) {
    for (const fileName of Object.keys(bundle)) {
      if (/KaTeX_.*\.(ttf|woff)$/.test(fileName)) {
        delete bundle[fileName];
      }
    }
  },
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), dropKatexLegacyFonts],

  resolve: {
    alias: {
      // mermaid 仅在渲染 flowchart-elk 图表时用到 ELK 布局引擎(约 1.4MB),
      // 本项目笔记不用该图表类型,替换为 stub 以缩小安装包。普通 flowchart
      // 走 dagre,不受影响。恢复方法见 src/lib/elk-stub.ts。
      "elkjs/lib/elk.bundled.js": fileURLToPath(
        new URL("./src/lib/elk-stub.ts", import.meta.url),
      ),
    },
  },

  build: {
    // Tauri 内嵌 WebView 较新，可用现代语法减少转译产物
    target: isWindowsTarget ? "chrome105" : "safari13",
    minify: "terser",
    terserOptions: {
      compress: {
        passes: 3,
        drop_console: true,
        drop_debugger: true,
        pure_getters: true,
      },
      mangle: true,
      format: {
        comments: false,
      },
    },
    cssMinify: true,
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 2000,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
