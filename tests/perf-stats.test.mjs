import { test } from "vitest";
import { selfCheckPerfStats } from "./perf-stats.mjs";

test("性能样本保持固定字节数，分位按正式样本量计算", () => {
  selfCheckPerfStats();
});
