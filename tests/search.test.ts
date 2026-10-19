import { describe, expect, it } from "vitest";
import { findMatches } from "../src/search";

describe("正文搜索的 UTF-16 范围", () => {
  it("把正则元字符当成字面文本，支持中文与大小写", () => {
    expect(findMatches("中文 [a.b] 和 [A.B]", "[a.b]").matches).toEqual([{ start: 3, end: 8 }, { start: 11, end: 16 }]);
  });
  it("在表情和变长 Unicode 大小写附近保留原文位置", () => {
    expect(findMatches("😀 İ FILE 中文", "file").matches).toEqual([{ start: 5, end: 9 }]);
  });
  it("处理空查询并显式报告结果上限", () => {
    expect(findMatches("abc", "").matches).toEqual([]);
    expect(findMatches("aaaa", "a", 2)).toEqual({ matches: [{ start: 0, end: 1 }, { start: 1, end: 2 }], truncated: true });
  });
});
