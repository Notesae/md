import assert from "node:assert/strict";

// 正式性能口径。脚本可以少采样做诊断，但少于这些次数不得当成 SPEC 样本。
export const FORMAL_SAMPLE_COUNT = 30;
export const FORMAL_SWITCH_COUNT = 100;
export const SPEC_OPEN_1MB_P95_MS = 200;
export const SPEC_OPEN_10MB_P95_MS = 1000;
export const SPEC_SEARCH_1MB_P95_MS = 100;
export const SPEC_STEADY_PRIVATE_BYTES = 250 * 1024 * 1024;

const unit = "## 阅读章节\n\n" + "阅读的节奏来自清晰的段落和适当的留白。这个本地文档用于测量全文解析、首屏绘制、目录和搜索。性能验收标记。".repeat(12) + "\n\n- 保留原始文件\n- 后台读取与解析\n- 按需显示正文\n\n> 先测量，再根据证据改进。\n\n";

/** 最近秩。P95 使用 ceil(n * 0.95) 的位置，不把少量样本外推成稳定分布。 */
export function summarize(values) {
  if (!values.length) throw new Error("没有样本");
  const ordered = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    median: ordered[Math.ceil(ordered.length * 0.5) - 1],
    p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
    max: ordered.at(-1),
  };
}

/** 固定 UTF-8 字节数。补齐只用 ASCII 空格，不截断多字节字符。 */
export function performanceDocument(size) {
  const heading = `# ${size} 字节性能样本\n\n`;
  const headingBytes = Buffer.byteLength(heading);
  const unitBytes = Buffer.byteLength(unit);
  if (headingBytes >= size) throw new Error("样本尺寸小于标题");
  const count = Math.floor((size - headingBytes) / unitBytes);
  const body = heading + unit.repeat(count);
  const pad = size - Buffer.byteLength(body);
  if (pad < 0) throw new Error("样本填充为负");
  return body + " ".repeat(pad);
}

export function selfCheckPerfStats() {
  assert.equal(FORMAL_SAMPLE_COUNT, 30);
  assert.equal(FORMAL_SWITCH_COUNT, 100);
  for (const size of [100_000, 1_000_000, 10_000_000]) {
    const document = performanceDocument(size);
    assert.equal(Buffer.byteLength(document), size);
    assert.equal(document.includes("性能验收标记"), true);
    assert.equal(document.includes("\uFFFD"), false);
  }
  const ten = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(ten, { count: 10, median: 5, p95: 10, max: 10 });
  const thirty = summarize(Array.from({ length: 30 }, (_, index) => index + 1));
  assert.equal(thirty.count, 30);
  assert.equal(thirty.median, 15);
  assert.equal(thirty.p95, 29);
  assert.equal(thirty.max, 30);
  assert.throws(() => summarize([]));
}
