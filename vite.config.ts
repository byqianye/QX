import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  root: "renderer",
  base: "./",
  plugins: [vue()],
  server: {
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    outDir: "../dist/renderer",
    emptyOutDir: true,
  },
});
