// 操作图标统一使用 20px 画布、1.5px 描边与圆角线端；文件、导航和外观图标按中心对齐。
const paths: Record<string, string> = {
  file: '<path d="M11.5 3H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7.5Z"/><path d="M11.5 3v4.5H16M7 11h6M7 14h4"/>',
  folder: '<path d="M3 6v-.5A1.5 1.5 0 0 1 4.5 4H8l2 2h5.5A1.5 1.5 0 0 1 17 7.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5Z"/>',
  search: '<circle cx="9" cy="9" r="5.5"/><path d="m13 13 4 4"/>',
  settings: '<path d="M8.5 3h3l.5 1.8 1.2.7L15 5l1.5 2.6-1.3 1.3v2.2l1.3 1.3L15 15l-1.8-.5-1.2.7-.5 1.8h-3L8 15.2l-1.2-.7L5 15l-1.5-2.6 1.3-1.3V8.9L3.5 7.6 5 5l1.8.5L8 4.8Z"/><circle cx="10" cy="10" r="2.5"/>',
  sidebar: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M7.5 4v12"/>',
  outline: '<path d="M3 4h.01M7 4h10M3 10h.01M7 10h10M3 16h.01M7 16h10"/>',
  chevron: '<path d="m7 5 5 5-5 5"/>',
  close: '<path d="m5 5 10 10M15 5 5 15"/>',
  // 窗口控件沿用同一描边图标，最大化后以重叠方框表示还原。
  minimize: '<path d="M4 10h12"/>',
  maximize: '<rect x="4" y="4" width="12" height="12"/>',
  restore: '<path d="M7 6V3h10v10h-3"/><rect x="3" y="7" width="10" height="10"/>',
  previous: '<path d="m12 5-5 5 5 5"/>',
  next: '<path d="m8 5 5 5-5 5"/>',
  // 结果导航使用上下方向，纸面选择以对勾表示当前主题。
  up: '<path d="m5 12 5-5 5 5"/>',
  down: '<path d="m5 8 5 5 5-5"/>',
  check: '<path d="m5 10 3.5 3.5L15 7"/>',
  // 数值步进与已有操作图标共用描边和画布，不使用浏览器原生上下小箭头。
  minus: '<path d="M4 10h12"/>',
  plus: '<path d="M4 10h12M10 4v12"/>',
  sun: '<circle cx="10" cy="10" r="3"/><path d="M10 3v1M10 16v1M3 10h1M16 10h1M5 5l1 1M14 14l1 1M5 15l1-1M14 6l1-1"/>',
  moon: '<path d="M16.5 11.2A6.7 6.7 0 0 1 8.8 3.5a6.8 6.8 0 1 0 7.7 7.7Z"/>',
  copy: '<rect x="7" y="7" width="10" height="11" rx="1"/><path d="M13 7V2H3v11h4"/>',
  refresh: '<path d="M17 7a7 7 0 1 0 0 6M17 2v5h-5"/>',
  // 状态栏以锁表示只读，不使用文字强调。
  lock: '<rect x="4.5" y="9" width="11" height="8" rx="1.5"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>',
  book: '<path d="M10 5C7 2 4 2 2 3v13c3-1 5 0 8 2 3-2 5-3 8-2V3c-3-1-5 0-8 2Zm0 0v13"/>',
};

export function icon(name: string): string {
  return `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.file}</svg>`;
}
