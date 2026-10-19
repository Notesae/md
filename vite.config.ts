import { defineConfig } from "vite";

// 桌面开发端口固定，资源使用相对路径以便 release 内嵌加载。
export default defineConfig({
  base: "./",
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  build: { target: "es2022" },
});
