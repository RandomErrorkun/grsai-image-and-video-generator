/**
 * grsai_config.json 的数据模型与进程内存储（对应 core/config.py）。
 *
 * 键名和默认值与源项目保持一致，旧数据可以直接导入。文件读写通过
 * ConfigStorage 注入，core 层不依赖具体的运行环境。
 */

export const CONFIG_FILE_NAME = "grsai_config.json";

export const DEFAULT_CONFIG = {
  api_base_url: "https://grsai.dakka.com.cn",
  api_key: "",
  output_folder: "./output",
  last_model: "nano-banana-2-lite",
  // Nano Banana parameters
  nano_banana_aspect_ratio: "auto",
  nano_banana_image_size: "1K",
  // GPT Image parameters
  gpt_image_size: "auto",
  gpt_image_quality: "auto",
  gpt_image_tier: "1K",
  gpt_image_output_format: "png",
  gpt_transparent_background: false,
  // Video generation parameters
  video_last_model: "minimax-h3",
  video_aspect_ratio: "landscape",
  video_resolution: "480p",
  video_duration: 5,
  video_parallel_tasks: 1,
  // agnes-video-2.5 parameters
  agnes_video_aspect_ratio: "16:9",
  agnes_video_resolution: "720p",
  agnes_video_duration: 5,
  // wan-3.0 parameters
  wan_video_aspect_ratio: "16:9",
  wan_video_resolution: "720p",
  wan_video_duration: 5,
  // 首尾帧素材模式（仅支持 firstFrame/lastFrame 的模型生效）
  video_frames_mode: false,
  // Shared parameters
  auto_retry_on_failure: false,
  vip_moderation_auto_retry: false,
  parallel_tasks: 1,
  comic_parallel_tasks: 2,
  max_retries: 5,
  theme: "auto",
  language: "en",
  text_format_enabled: true,
  text_font_size: 12,
  text_font_family: "Arial",
  text_auto_wrap: true,
  comic_story_model: "gemini-3.1-pro",
  comic_image_model: "nano-banana-2-lite",
  comic_page_count: 6,
  comic_aspect_ratio: "3:4",
  comic_image_size: "1K",
  comic_last_project: "",
  // History page settings
  history_items_per_page: 5,
  last_tab: "banana_pro",
} as const;

/** 配置值的类型；源项目的配置里只出现这三种。 */
export type ConfigValue = string | number | boolean;

type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : never;

/**
 * grsai_config.json 的全部固定键。
 * 运行时还会追加 last_model_tab_<tab> 这类键，它们不在类型里，用带默认值的 get() 读。
 */
export type AppConfig = {
  [K in keyof typeof DEFAULT_CONFIG]: Widen<(typeof DEFAULT_CONFIG)[K]>;
};

type MaybePromise<T> = T | Promise<T>;

type LooseConfig = Record<string, unknown>;

export interface ConfigStorage {
  /** 读取配置文件全文；文件不存在时返回 null，其余失败抛错。 */
  read(): MaybePromise<string | null>;
  /** 写入配置文件全文。 */
  write(text: string): MaybePromise<void>;
}

export interface ConfigStoreOptions {
  /** 读写出错时的回调；默认打到 console.error。 */
  onError?: (error: unknown) => void;
}

export interface ConfigStore {
  /** 当前配置。读取用 get()，写入用 set()，不要直接改这里的键。 */
  readonly data: AppConfig;
  get<K extends keyof AppConfig>(key: K, fallback: AppConfig[K]): AppConfig[K];
  get<K extends keyof AppConfig>(key: K): AppConfig[K] | undefined;
  get<T extends ConfigValue>(key: string, fallback: T): T;
  get(key: string): ConfigValue | null | undefined;
  set(key: string, value: ConfigValue): void;
  /** 从存储读入配置（对应 Config.load_config），读不到或损坏时回落到默认值。 */
  load(): Promise<void>;
  /** 把当前配置写回存储（对应 Config.save_config）；连续调用会合并，不会乱序覆盖。 */
  save(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

function isRecord(value: unknown): value is LooseConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 和源项目的 json.dump(indent=4) 保持同一格式，方便用户手改和比对。 */
export function serializeConfig(data: AppConfig): string {
  return JSON.stringify(data, null, 4);
}

function assignEntries(target: LooseConfig, source: LooseConfig): void {
  // 不用 Object.assign：JSON 里的 "__proto__" 键会经由 setter 改掉原型。
  for (const [key, value] of Object.entries(source)) {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

/** 用读到的配置覆盖 data，并补齐缺失的默认键（对应 _migrate_config 末尾的补键逻辑）。 */
function replaceData(data: AppConfig, source: LooseConfig): void {
  const target = data as unknown as LooseConfig;
  for (const key of Object.keys(target)) delete target[key];
  assignEntries(target, source);
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (!(key in target)) target[key] = value;
  }
}

export function createConfigStore(
  storage: ConfigStorage,
  options: ConfigStoreOptions = {},
): ConfigStore {
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error("[config] failed to access grsai_config.json", error);
    });
  const listeners = new Set<() => void>();
  const data: AppConfig = { ...DEFAULT_CONFIG };
  let pending: Promise<void> = Promise.resolve();
  let writing = false;
  let dirty = false;

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function save(): Promise<void> {
    if (writing) {
      // 上一次还没写完：记一笔，等它结束后再写最新的内容。
      dirty = true;
      return pending;
    }
    writing = true;
    // 记下调用这一刻的内容：后面再改配置要等这次写完，按顺序轮到它。
    const text = serializeConfig(data);
    pending = Promise.resolve()
      .then(() => storage.write(text))
      .catch(onError)
      .finally(() => {
        writing = false;
        if (dirty) {
          dirty = false;
          void save();
        }
      });
    return pending;
  }

  async function load(): Promise<void> {
    let text: string | null;
    try {
      text = await storage.read();
    } catch (error) {
      // 文件在却读不了：和源项目一样回落到默认值，且不回写，免得覆盖用户手里的文件。
      onError(error);
      replaceData(data, DEFAULT_CONFIG);
      notify();
      return;
    }

    let loaded: unknown = DEFAULT_CONFIG;
    if (text === null) {
      // 首次启动：生成默认配置，稍后落盘。
    } else {
      try {
        loaded = JSON.parse(text);
        if (!isRecord(loaded)) throw new SyntaxError("config root is not an object");
      } catch {
        // 文件损坏：只回落到默认值，不回写，给用户留下排查的余地。
        loaded = DEFAULT_CONFIG;
      }
    }
    replaceData(data, loaded as LooseConfig);
    notify();
    if (text === null) await save();
  }

  function get(key: string, fallback?: ConfigValue): ConfigValue | null | undefined {
    // 与 dict.get 一致：键存在就返回它的值（哪怕是 null），缺键才用默认值。
    return key in data
      ? (data as unknown as Record<string, ConfigValue | null>)[key]
      : fallback;
  }

  function set(key: string, value: ConfigValue): void {
    (data as unknown as LooseConfig)[key] = value;
    notify();
    void save();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { data, get, set, load, save, subscribe };
}
