/**
 * grsai_config.json 的数据模型与进程内存储（Schema v2 按 Tab 分块）。
 *
 * 磁盘格式：
 * {
 *   "config_version": 2,
 *   "settings": { ... },
 *   "image":    { ... },
 *   "video":    { ... },
 *   "comic":    { ... },
 *   "pose":     { ... }
 * }
 *
 * 启动读取旧版扁平 grsai_config.json 时，会自动完成旧键迁移（含默认提示词字体统一升级为
 * JetBrainsMapleMono），重构为 v2 分块字典并静默写回磁盘；损坏文件回落默认值且绝不覆盖。
 */
import { LEGACY_IMAGE_MODEL_ALIASES } from "./modelCatalog";
import { DEFAULT_POSE_CONFIG, normalizePoseConfig, type PoseStudioConfig } from "./poseConfig";
import { pyStr } from "./py";

export const CONFIG_FILE_NAME = "grsai_config.json";
export const CONFIG_SCHEMA_VERSION = 2;

export type ConfigSectionName = "settings" | "image" | "video" | "comic" | "pose";

export const DEFAULT_CONFIG = {
  api_base_url: "https://grsai.dakka.com.cn",
  api_key: "",
  // Grsai 官网地址（可写或不写 https://），用于拉取模型可用性、积分价目表与官方公告
  grsai_site_url: "grsai.ai",
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
  // 提交并发闸：同时在途的提交请求数上限。重写版新增的键，取手册建议区间 2 到 3 的上沿
  submit_concurrency: 3,
  // 主题色，#RRGGBB。源项目写死 #0078D4，这里做成可调，重写版新增的键
  accent_color: "#0078D4",
  // 媒体预览方式："internal" 软件内部灯箱预览（默认） | "system" 系统默认程序打开。重写版新增的键
  preview_mode: "internal",
  theme: "auto",
  language: "en",
  text_format_enabled: true,
  text_font_size: 9,
  text_font_family: "JetBrainsMapleMono",
  text_auto_wrap: true,
  // 3D 姿势页导出分辨率变更时，水印与角色标号的目标面积占比（(0, 1) 开区间，支持 4 位小数）
  pose_watermark_area_ratio: 0.02,
  pose_label_area_ratio: 0.003,
  comic_story_model: "gemini-3.1-pro",
  comic_image_model: "nano-banana-2-lite",
  comic_page_count: 6,
  comic_aspect_ratio: "3:4",
  comic_image_size: "1K",
  comic_last_project: "",
  // 漫画页自定义 OpenAI 兼容对话接口（重写版新增，留空时走 Grsai 中转）
  comic_custom_chat_base_url: "",
  comic_custom_chat_endpoint: "",
  comic_custom_chat_api_key: "",
  comic_custom_chat_model: "",
  comic_custom_chat_body: "",
  // History page settings
  history_items_per_page: 5,
  last_tab: "banana_pro",
} as const;

/** 配置标量值的类型；源项目的所有扁平键只出现这三种。 */
export type ConfigValue = string | number | boolean;

type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : never;

/**
 * 扁平视图里的全部固定键（供各页面通过 cfg.get/set 访问，底层自动归位到对应 Tab 块）。
 */
export type AppConfig = {
  [K in keyof typeof DEFAULT_CONFIG]: Widen<(typeof DEFAULT_CONFIG)[K]>;
};

export interface SectionedConfigFile {
  config_version: 2;
  settings: Record<string, unknown>;
  image: Record<string, unknown>;
  video: Record<string, unknown>;
  comic: Record<string, unknown>;
  pose: PoseStudioConfig;
}

/** 每个固定键在磁盘 v2 分块 JSON 中的归属 Tab。 */
export const KEY_SECTION_MAP: Readonly<Record<keyof AppConfig, Exclude<ConfigSectionName, "pose">>> = {
  // settings tab & global preferences
  api_base_url: "settings",
  api_key: "settings",
  grsai_site_url: "settings",
  output_folder: "settings",
  auto_retry_on_failure: "settings",
  vip_moderation_auto_retry: "settings",
  max_retries: "settings",
  submit_concurrency: "settings",
  accent_color: "settings",
  preview_mode: "settings",
  theme: "settings",
  language: "settings",
  text_format_enabled: "settings",
  text_font_size: "settings",
  text_font_family: "settings",
  text_auto_wrap: "settings",
  pose_watermark_area_ratio: "settings",
  pose_label_area_ratio: "settings",
  comic_custom_chat_base_url: "settings",
  comic_custom_chat_endpoint: "settings",
  comic_custom_chat_api_key: "settings",
  comic_custom_chat_model: "settings",
  comic_custom_chat_body: "settings",
  history_items_per_page: "settings",

  // image generator tab
  last_tab: "image",
  last_model: "image",
  parallel_tasks: "image",
  nano_banana_aspect_ratio: "image",
  nano_banana_image_size: "image",
  gpt_image_size: "image",
  gpt_image_quality: "image",
  gpt_image_tier: "image",
  gpt_image_output_format: "image",
  gpt_transparent_background: "image",

  // video generator tab
  video_last_model: "video",
  video_aspect_ratio: "video",
  video_resolution: "video",
  video_duration: "video",
  video_parallel_tasks: "video",
  agnes_video_aspect_ratio: "video",
  agnes_video_resolution: "video",
  agnes_video_duration: "video",
  wan_video_aspect_ratio: "video",
  wan_video_resolution: "video",
  wan_video_duration: "video",
  video_frames_mode: "video",

  // comic generator tab
  comic_story_model: "comic",
  comic_image_model: "comic",
  comic_page_count: "comic",
  comic_aspect_ratio: "comic",
  comic_image_size: "comic",
  comic_parallel_tasks: "comic",
  comic_last_project: "comic",
};

/** 决定任意键（含动态键 last_model_tab_*、video_params_*）归属于哪一个 Tab 块。 */
export function sectionForKey(key: string): Exclude<ConfigSectionName, "pose"> {
  if (hasKey(KEY_SECTION_MAP, key)) {
    return KEY_SECTION_MAP[key as keyof AppConfig];
  }
  if (key.startsWith("last_model_tab_") || key.startsWith("last_model_")) return "image";
  if (key.startsWith("video_params_") || key.startsWith("video_")) return "video";
  if (key.startsWith("comic_custom_chat_")) return "settings";
  if (key.startsWith("comic_")) return "comic";
  return "settings";
}

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
  /** 当前扁平视图配置。读取用 get()，写入用 set()，不要直接改这里的键。 */
  readonly data: AppConfig;
  get<K extends keyof AppConfig>(key: K, fallback: AppConfig[K]): AppConfig[K];
  get<K extends keyof AppConfig>(key: K): AppConfig[K] | undefined;
  get<T extends ConfigValue>(key: string, fallback: T): T;
  get(key: string): ConfigValue | null | undefined;
  set(key: string, value: ConfigValue): void;
  /** 读取 3D 姿势页专属配置块（永远返回完整规范化副本）。 */
  getPoseConfig(): PoseStudioConfig;
  /** 写入/合并 3D 姿势页专属配置块并持久化。 */
  setPoseConfig(next: PoseStudioConfig): void;
  /** 导出当前内存对应的 v2 分块磁盘结构（用于持久化或调试）。 */
  toSectioned(): SectionedConfigFile;
  /** 从存储读入配置（若检测到老版本扁平格式，静默重构为 v2 分块格式并写回磁盘）。 */
  load(): Promise<void>;
  /** 把当前配置写回存储；连续调用会合并，不会乱序覆盖。 */
  save(): Promise<void>;
  /** 等还没写完的配置落盘；没有在写的就直接完成，不会再写一遍。 */
  flush(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

function isRecord(value: unknown): value is LooseConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只认自有键的查表，与 dict 的 in 一致。 */
function hasKey(table: object, key: unknown): boolean {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key);
}

/** 判断读入的 JSON 对象是否已经是 v2 分块结构。 */
export function isSectionedConfigV2(raw: unknown): raw is SectionedConfigFile {
  if (!isRecord(raw)) return false;
  if (raw.config_version !== CONFIG_SCHEMA_VERSION) return false;
  return (
    isRecord(raw.settings) ||
    isRecord(raw.image) ||
    isRecord(raw.video) ||
    isRecord(raw.comic) ||
    isRecord(raw.pose)
  );
}

/** 将扁平键表和 pose 块组装为 v2 分块磁盘结构。 */
export function packSectionedConfig(
  flat: AppConfig,
  pose: PoseStudioConfig = DEFAULT_POSE_CONFIG,
): SectionedConfigFile {
  const settings: Record<string, unknown> = {};
  const image: Record<string, unknown> = {};
  const video: Record<string, unknown> = {};
  const comic: Record<string, unknown> = {};
  const buckets = { settings, image, video, comic };

  for (const [key, value] of Object.entries(flat as unknown as LooseConfig)) {
    const section = sectionForKey(key);
    buckets[section][key] = value;
  }

  return {
    config_version: CONFIG_SCHEMA_VERSION,
    settings,
    image,
    video,
    comic,
    pose: normalizePoseConfig(pose),
  };
}

/** 序列化为 4 空格缩进的 v2 分块 JSON，方便用户手改和按 Tab 阅读。 */
export function serializeConfig(
  data: AppConfig,
  pose: PoseStudioConfig = DEFAULT_POSE_CONFIG,
): string {
  return JSON.stringify(packSectionedConfig(data, pose), null, 4);
}

/** 旧的标签名到现行标签键。 */
const TAB_KEY_MAP: Readonly<Record<string, string>> = {
  "Banana 1": "banana_pro",
  "Banana Pro": "banana_pro",
  "GPT Image": "gpt_image",
};

/**
 * 旧配置迁移（对应 _migrate_config）：把早期的键名换成现行的，并补齐缺失的默认键。
 * 键的先后顺序照搬，文件里的排列不会被打乱。
 * 迁移途中遇到源项目会抛异常的脏数据时同样抛错，由 load() 回落到默认值。
 */
export function migrateConfig(oldConfig: unknown): AppConfig {
  if (!isRecord(oldConfig)) {
    throw new TypeError(`'${pyStr(oldConfig)}' object has no attribute 'get'`);
  }
  const migrated: LooseConfig = { ...oldConfig };

  // 最早的 last_aspect_ratio / last_image_size 改成了 nano_banana_*
  for (const [oldKey, newKey] of [
    ["last_aspect_ratio", "nano_banana_aspect_ratio"],
    ["last_image_size", "nano_banana_image_size"],
  ] as const) {
    if (oldKey in migrated) {
      const value = migrated[oldKey];
      delete migrated[oldKey];
      migrated[newKey] = value;
    }
  }

  // 早期直连 Google Gemini 的地址换回 Grsai
  if ("api_base_url" in migrated && typeof migrated.api_base_url !== "string") {
    throw new TypeError(`'${pyStr(migrated.api_base_url)}' object has no attribute 'startswith'`);
  }
  if (typeof migrated.api_base_url === "string" && migrated.api_base_url.startsWith("https://generativelanguage.googleapis.com")) {
    migrated.api_base_url = DEFAULT_CONFIG.api_base_url;
  }

  // 旧模型名换成现行模型名；列表这类不可哈希的值与源项目一样让迁移失败
  const remapModel = (value: unknown): unknown => {
    if (typeof value === "object" && value !== null) {
      throw new TypeError(`unhashable type: '${Array.isArray(value) ? "list" : "dict"}'`);
    }
    return hasKey(LEGACY_IMAGE_MODEL_ALIASES, value) ? LEGACY_IMAGE_MODEL_ALIASES[value as string] : value;
  };
  if ("last_model" in migrated) migrated.last_model = remapModel(migrated.last_model);
  if ("comic_image_model" in migrated) migrated.comic_image_model = remapModel(migrated.comic_image_model);
  for (const [key, value] of Object.entries(migrated)) {
    if (key.startsWith("last_model_")) migrated[key] = remapModel(value);
  }

  // 旧的标签显示名改成稳定的标签键
  const hashableTab = (value: unknown): string => {
    if (typeof value === "object" && value !== null) throw new TypeError("unhashable type: 'list'");
    return value as string;
  };
  if ("last_tab" in migrated && hasKey(TAB_KEY_MAP, hashableTab(migrated.last_tab))) {
    migrated.last_tab = TAB_KEY_MAP[migrated.last_tab as string];
  }

  // 独立的 Banana 1 标签已经并进 Banana，旧值折过去
  if (migrated.last_tab === "banana_1") migrated.last_tab = "banana_pro";

  // Banana 1 标签记住的模型，只在 Banana 标签还没记住模型时带过去
  const legacyBanana1Key = "last_model_tab_banana_1";
  const bananaProKey = "last_model_tab_banana_pro";
  if (legacyBanana1Key in migrated && !(bananaProKey in migrated)) {
    const legacyValue = remapModel(migrated[legacyBanana1Key]);
    migrated[bananaProKey] = legacyValue;
  }

  for (const [oldName, newKey] of Object.entries(TAB_KEY_MAP)) {
    const oldModelKey = `last_model_${oldName}`;
    const newModelKey = `last_model_tab_${newKey}`;
    if (oldModelKey in migrated && !(newModelKey in migrated)) {
      migrated[newModelKey] = migrated[oldModelKey];
    }
  }

  // 补齐缺失的默认键
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (!(key in migrated)) migrated[key] = value;
  }
  return migrated as AppConfig;
}

/**
 * 解析任意版本（v1 扁平 或 v2 分块）的已解析 JSON，返回统一扁平视图、pose 块与是否需要静默重写标记。
 */
export function parseConfigPayload(raw: unknown): {
  flat: AppConfig;
  pose: PoseStudioConfig;
  migratedFromLegacy: boolean;
} {
  if (!isRecord(raw)) {
    throw new TypeError(`'${pyStr(raw)}' object has no attribute 'get'`);
  }

  if (isSectionedConfigV2(raw)) {
    const mergedFlat: LooseConfig = {};
    for (const section of ["settings", "image", "video", "comic"] as const) {
      const block = raw[section];
      if (isRecord(block)) {
        assignEntries(mergedFlat, block);
      }
    }
    const flat = migrateConfig(mergedFlat);
    const pose = normalizePoseConfig(raw.pose);
    return { flat, pose, migratedFromLegacy: false };
  }

  // 老版本 v1 扁平结构：先执行完整旧键迁移，再统一把默认提示词字体切到 JetBrainsMapleMono、旧默认 12 号字调到 9 号
  const legacyCopy: LooseConfig = { ...raw };
  const rawPose = legacyCopy.pose;
  delete legacyCopy.pose;
  delete legacyCopy.config_version;
  const flat = migrateConfig(legacyCopy);
  (flat as unknown as LooseConfig).text_font_family = DEFAULT_CONFIG.text_font_family;
  if (flat.text_font_size === 12) {
    (flat as unknown as LooseConfig).text_font_size = DEFAULT_CONFIG.text_font_size;
  }
  const pose = normalizePoseConfig(rawPose);
  return { flat, pose, migratedFromLegacy: true };
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

/** 用迁移后的配置覆盖 data。 */
function replaceData(data: AppConfig, source: AppConfig): void {
  const target = data as unknown as LooseConfig;
  for (const key of Object.keys(target)) delete target[key];
  assignEntries(target, source);
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
  let poseConfig: PoseStudioConfig = normalizePoseConfig(DEFAULT_POSE_CONFIG);
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
    const text = serializeConfig(data, poseConfig);
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
      replaceData(data, { ...DEFAULT_CONFIG });
      poseConfig = normalizePoseConfig(DEFAULT_POSE_CONFIG);
      notify();
      return;
    }

    if (text === null) {
      // 首次启动：生成默认 v2 分块配置并落盘。
      replaceData(data, { ...DEFAULT_CONFIG });
      poseConfig = normalizePoseConfig(DEFAULT_POSE_CONFIG);
      notify();
      await save();
      return;
    }

    let loadedFlat: AppConfig;
    let loadedPose: PoseStudioConfig;
    let shouldPersistMigration = false;
    try {
      const parsed = parseConfigPayload(JSON.parse(text));
      loadedFlat = parsed.flat;
      loadedPose = parsed.pose;
      shouldPersistMigration = parsed.migratedFromLegacy;
    } catch {
      // 文件损坏或有迁移不了的脏数据：只回落到默认值，不回写，给用户留下排查的余地。
      loadedFlat = { ...DEFAULT_CONFIG };
      loadedPose = normalizePoseConfig(DEFAULT_POSE_CONFIG);
      shouldPersistMigration = false;
    }
    replaceData(data, loadedFlat);
    poseConfig = loadedPose;
    notify();
    if (shouldPersistMigration) {
      // 启动检测到旧版扁平结构时，静默重构并落盘为新版 v2 分块 grsai_config.json
      await save();
    }
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

  function getPoseConfig(): PoseStudioConfig {
    return normalizePoseConfig(poseConfig);
  }

  function setPoseConfig(next: PoseStudioConfig): void {
    poseConfig = normalizePoseConfig(next);
    notify();
    void save();
  }

  function toSectioned(): SectionedConfigFile {
    return packSectionedConfig(data, poseConfig);
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  async function flush(): Promise<void> {
    // 连着改了好几次时写是排队进行的，要等最后一笔写完
    while (writing) await pending;
  }

  return { data, get, set, getPoseConfig, setPoseConfig, toSectioned, load, save, flush, subscribe };
}
