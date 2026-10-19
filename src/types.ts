/** 阅读偏好由后台校验并落盘，界面不使用浏览器缓存保存唯一状态。 */
export interface Preferences {
  theme: "light" | "dark" | "system";
  fontSize: number;
  contentWidth: number;
  sidebar: boolean;
  outline: boolean;
  persistentCache: boolean;
  cacheMib: number;
}

/** 启动时从必要数据区恢复的有限历史、窗口布局与阅读设置。 */
export interface AppState {
  preferences: Preferences;
  recent: (ReadingPosition & { path: string; openedAt: number })[];
  folders: string[];
  folderClosed: boolean;
  lastFile: string | null;
  window: { width: number; height: number; maximized: boolean };
}

/** 前后端共用的会话快照；数据根必须显示实际路径。 */
export interface Session {
  root: string;
  state: AppState;
  version: string;
  storageNotice: string | null;
}

/** 后台全文解析后的文档；所有块均为经过隔离的 HTML，图片与外链仍需显式授权。 */
export interface ReaderDocument {
  path: string;
  title: string;
  bytes: number;
  revision: number;
  readMs: number;
  parseMs: number;
  cacheMs: number;
  cacheHit: boolean;
  cacheError: string | null;
  blocks: string[];
  blockHashes: string[];
  headings: { id: string; title: string; level: number; block: number }[];
  images: { url: string; remote: boolean }[];
  links: string[];
}

/** 块摘要与偏移定位实际阅读内容，百分比仅用于目录变化后的保底恢复。 */
export interface ReadingPosition {
  position: number;
  block: number | null;
  offset: number;
  anchorHash: string | null;
}

/** 后台只返回当前目录的一层，展开子目录时再查询，禁止递归预读文章。 */
export interface DirectoryEntry {
  path: string;
  name: string;
  directory: boolean;
}
