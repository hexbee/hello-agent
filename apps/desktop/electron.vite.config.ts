import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@spike/shared"] })],
    build: {
      lib: {
        entry: resolve(__dirname, "src/main/index.ts"),
      },
      rollupOptions: {
        // NOTE: @spike/shared is bundled (its package entry is TS source);
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
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
