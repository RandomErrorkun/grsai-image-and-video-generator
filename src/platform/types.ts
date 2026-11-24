import type { HttpRequest, HttpOutcome } from "../core/api";
import type { ConfigStorage } from "../core/config";
import type { SqlExecutor } from "../core/history";
import type { PathTools } from "../core/paths";

export type NativeTheme = "light" | "dark";

/** 应用窗口的原生能力。浏览器 mock 下都是空操作。 */
export interface WindowApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  /** 窗口是否处于最大化；mock 下恒为 false。 */
  isMaximized(): Promise<boolean>;
  setTitle(title: string): Promise<void>;
  /**
   * 设置原生窗口主题，影响 WebView 的 prefers-color-scheme 和滚动条等原生部件；
   * 传 null 表示跟随系统。
   */
  setTheme(theme: NativeTheme | null): Promise<void>;
  /** 订阅窗口尺寸变化，返回取消订阅函数。 */
  onResized(listener: () => void): () => void;
}

/** 文件操作。读不到、写不了、不存在（除了 exists、isFile、isDir）都要抛错。 */
export interface FileSystemApi {
  exists(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  isDir(path: string): Promise<boolean>;
  /** 递归创建目录，已存在也不报错。 */
  makeDirs(path: string): Promise<void>;
  /** 目录下一层的条目名。 */
  readDir(path: string): Promise<string[]>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  copyFile(source: string, dest: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** 把 path 改名为 backup；backup 已存在时先删掉它。 */
  replaceWithBackup(path: string, backup: string): Promise<void>;
}

export interface HttpApi {
  /** 发出请求，拿到响应文本。网络问题用 HttpOutcome 表达，不抛错。 */
  request(request: HttpRequest): Promise<HttpOutcome>;
  /** 下载到 destPath，内容完整收到后才落盘。 */
  download(url: string, destPath: string): Promise<HttpOutcome>;
}

export interface Platform {
  readonly isTauri: boolean;
  /** 启动时准备一次：在 Tauri 里要先解析出数据目录，之后各能力才可用。 */
  init(): Promise<void>;
  /** 数据目录，也就是程序所在的目录。配置、历史库、input 和 output 都在这里。 */
  readonly dataDir: string;
  /** 路径工具，与源项目的 os.path 语义一致。 */
  readonly paths: PathTools;
  readonly window: WindowApi;
  readonly fs: FileSystemApi;
  readonly http: HttpApi;
  readonly configStorage: ConfigStorage;
  /** 打开（不存在就新建）一个 SQLite 数据库。 */
  openDatabase(path: string): Promise<SqlExecutor>;
}
