import { defineConfig } from "vitest/config";

// 本地工具链可能含旧工程副本；只收集当前仓库的测试，避免重复或过期用例混入结果。
export default defineConfig({ test: { include: ["tests/**/*.test.ts", "tests/**/*.test.mjs"] } });
