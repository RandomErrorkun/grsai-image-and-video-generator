import type { HttpRequest, HttpOutcome } from "../core/api";
import type { ConfigStorage } from "../core/config";
import type { SqlExecutor } from "../core/history";
import type { PathTools } from "../core/paths";

export type NativeTheme = "light" | "dark";

export interface CloseRequestEvent {
  preventDefault(): void;
}

/** 应用窗口的原生能力。浏览器 mock 下都是空操作。 */
export interface WindowApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  /** 直接销毁窗口，不再触发 onCloseRequested。 */
  destroy(): Promise<void>;
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
  /** 订阅窗口关闭请求（标题栏 × 和系统关闭都会走到这里），返回取消订阅函数。 */
  onCloseRequested(listener: (event: CloseRequestEvent) => void | Promise<void>): () => void;
}

/** 文件操作。读不了、写不了、不存在（除了 exists、isFile、isDir）都要抛错。 */
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
  /** 计算本地文件的 SHA-256（小写十六进制），用于校验历史结果文件是否被替换。 */
  sha256(path: string): Promise<string>;
}

export interface HttpApi {
  /** 发出请求，拿到响应文本。网络问题用 HttpOutcome 表达，不抛错。 */
  request(request: HttpRequest): Promise<HttpOutcome>;
  /** 下载到 destPath，内容完整收到后才落盘。 */
  download(url: string, destPath: string): Promise<HttpOutcome>;
}

/** 文件对话框里的文件类型筛选；extensions 不带点。 */
export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface DialogApi {
  /** 选文件，返回所选路径；用户取消时是空数组。 */
  pickFiles(options?: { title?: string; multiple?: boolean; filters?: FileFilter[] }): Promise<string[]>;
  /** 选文件夹；用户取消时是 null。 */
  pickDirectory(options?: { title?: string; defaultPath?: string | null }): Promise<string | null>;
}

export interface OpenerApi {
  /** 用系统默认程序打开一个文件，或者打开一个文件夹。 */
  openPath(path: string): Promise<void>;
}

/**
 * 剪贴板里当前的东西。顺序与源项目一致：先看位图，再看文件，最后才是文本。
 * 位图不直接给数据，先存成 `<数据目录>/input/grsai_clipboard_<unix 秒>.png`，给回这个路径。
 */
export type ClipboardSnapshot =
  | { kind: "empty" }
  | { kind: "image"; path: string }
  | { kind: "files"; paths: string[] }
  | { kind: "text"; text: string };

export interface ClipboardApi {
  read(): Promise<ClipboardSnapshot>;
  /** 把 RGBA 像素数据写入系统剪贴板。 */
  writeImage(rgba: Uint8Array, width: number, height: number): Promise<void>;
}

export interface DragDropEvent {
  /** enter 是拖着东西进入窗口，over 是在窗口里移动，drop 是松手，leave 是拖着东西离开了窗口。 */
  type: "enter" | "over" | "drop" | "leave";
  /** 光标相对窗口内容区左上角的位置，单位是 CSS 像素。 */
  position: { x: number; y: number };
  paths: string[];
}

export interface DragDropApi {
  /** 订阅拖放。Tauri 会替窗口接管拖放，网页收不到浏览器自己的 drop 事件。 */
  subscribe(handler: (event: DragDropEvent) => void): () => void;
}

/** 给本地文件生成可用于 img、audio 的地址。 */
export interface MediaApi {
  /**
   * 把路径加进放行名单。对话框选中的路径系统会自动放行，
   * 拖进来的、从历史记录里翻出来的、用户另选的输出文件夹都要先过这一道。
   */
  allow(paths: string[], recursive?: boolean): Promise<void>;
  /** 本地文件在页面里的地址。 */
  url(path: string): string;
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
  readonly dialog: DialogApi;
  readonly opener: OpenerApi;
  readonly clipboard: ClipboardApi;
  readonly dragDrop: DragDropApi;
  readonly media: MediaApi;
}
