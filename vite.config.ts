import { defineConfig } from "vite";

// 桌面开发端口固定，资源使用相对路径以便 release 内嵌加载；首次引导页单独成页，不加载阅读器代码。
export default defineConfig({
  base: "./",
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  build: { target: "es2022", rollupOptions: { input: { main: "index.html", setup: "setup.html" } } },
});
