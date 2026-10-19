/** 搜索结果使用原始 UTF-16 偏移，能直接映射到 DOM Range；超过上限明确标记。 */
export interface SearchResult {
  matches: { start: number; end: number }[];
  truncated: boolean;
}

/** 按字面量搜索而非执行用户正则，避免回溯及 Unicode 转小写造成的偏移漂移。 */
export function findMatches(text: string, query: string, limit = 5000): SearchResult {
  if (!query) return { matches: [], truncated: false };
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const matches: SearchResult["matches"] = [];
  for (const match of text.matchAll(expression)) {
    if (matches.length === limit) return { matches, truncated: true };
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return { matches, truncated: false };
}
