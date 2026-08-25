import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@hello-agent/shared"] })],
    build: {
      lib: {
        entry: {
          index: resolve(__dirname, "src/main/index.ts"),
          // §8 smoke probe: AUTH_SMOKE_OUT=... electron ./apps/desktop/out/main/auth-smoke.js
          "auth-smoke": resolve(__dirname, "src/main/auth-smoke.ts"),
        },
      },
      rollupOptions: {
        // NOTE: @hello-agent/shared is bundled (its package entry is TS source);
        // only pi stays external.
        external: ["@earendil-works/pi-coding-agent"],
      },
    },
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "../../packages/shared/src"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve(__dirname, "src/preload/index.ts"),
        fileName: () => "index.js",
      },
      rollupOptions: {
        output: { format: "cjs" }, // sandboxed preload must be CJS
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        // beUI generated components use shadcn-style "@/" imports
        "@": resolve(__dirname, "src/renderer"),
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      {
        // §3.3 strict CSP ships in the build; relax connect-src only in the
        // dev server so Vite HMR websocket can connect.
        name: "csp-dev-relax",
        transformIndexHtml(html, ctx) {
          if (!ctx.server) return html;
          return html.replace(
            "connect-src 'none'",
            "connect-src 'self' ws://localhost:* http://localhost:*",
          );
        },
      },
    ],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
