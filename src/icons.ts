// 统一 20px、1.6px 描边的操作图标；不把用户或文档内容插入 SVG。
const paths: Record<string, string> = {
  file: '<path d="M11 2H4v16h12V7zM11 2v5h5M7 11h6M7 14h6"/>',
  folder: '<path d="M2 5h6l2 2h8v10H2zM2 5V3h6l2 2h6v2"/>',
  search: '<circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/>',
  settings: '<path d="m8 2-.8 2.1-2.2.3-1.5 2.6.9 2-.9 2 1.5 2.6 2.2.3L8 16h3l.8-2.1 2.2-.3 1.5-2.6-.9-2 .9-2L14 4.4l-2.2-.3L11 2Z"/><circle cx="9.5" cy="9" r="2.5"/>',
  sidebar: '<rect x="2" y="3" width="16" height="14" rx="2"/><path d="M7 3v14"/>',
  outline: '<path d="M7 4h10M7 10h10M7 16h10M3 4h.1M3 10h.1M3 16h.1"/>',
  chevron: '<path d="m7 5 5 5-5 5"/>',
  close: '<path d="m5 5 10 10M15 5 5 15"/>',
  previous: '<path d="m12 5-5 5 5 5"/>',
  next: '<path d="m8 5 5 5-5 5"/>',
  sun: '<circle cx="10" cy="10" r="3.5"/><path d="M10 1v2m0 14v2M1 10h2m14 0h2M3.5 3.5 5 5m10 10 1.5 1.5M3.5 16.5 5 15M15 5l1.5-1.5"/>',
  moon: '<path d="M17 12.5A7.5 7.5 0 0 1 7.5 3 7.5 7.5 0 1 0 17 12.5Z"/>',
  copy: '<rect x="7" y="7" width="10" height="11" rx="1"/><path d="M13 7V2H3v11h4"/>',
  refresh: '<path d="M17 7a7 7 0 1 0 0 6M17 2v5h-5"/>',
  book: '<path d="M10 5C7 2 4 2 2 3v13c3-1 5 0 8 2 3-2 5-3 8-2V3c-3-1-5 0-8 2Zm0 0v13"/>',
};

export function icon(name: string): string {
  return `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.file}</svg>`;
}
