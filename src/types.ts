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
  recent: { path: string; position: number; openedAt: number }[];
  folders: string[];
  lastFile: string | null;
  window: { width: number; height: number; maximized: boolean };
}

/** 前后端共用的会话快照；数据根必须显示实际路径。 */
export interface Session {
  root: string;
  state: AppState;
  version: string;
}
