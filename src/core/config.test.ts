import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  createConfigStore,
  serializeConfig,
  type ConfigStorage,
} from "./config";

/** 内存里的配置文件，行为和真实文件一致：没写过就是不存在。 */
function memoryStorage(initial?: string) {
  let text: string | null = initial ?? null;
  const storage: ConfigStorage = {
    read: () => text,
    write: (next) => {
      text = next;
    },
  };
  return {
    storage,
    get text() {
      return text;
    },
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 重写版新增的配置键，源项目的配置文件里没有。 */
const REWRITE_ONLY_KEYS = ["submit_concurrency", "accent_color"];

describe("config defaults", () => {
  it("has the 42 keys of the source project plus the two the rewrite adds", () => {
    expect(Object.keys(DEFAULT_CONFIG)).toHaveLength(44);
    expect(Object.keys(DEFAULT_CONFIG).filter((key) => !REWRITE_ONLY_KEYS.includes(key))).toHaveLength(42);
    expect(DEFAULT_CONFIG.submit_concurrency).toBe(3);
    expect(DEFAULT_CONFIG.accent_color).toBe("#0078D4");
    expect(DEFAULT_CONFIG.api_base_url).toBe("https://grsai.dakka.com.cn");
    expect(DEFAULT_CONFIG.output_folder).toBe("./output");
    expect(DEFAULT_CONFIG.last_model).toBe("nano-banana-2-lite");
    expect(DEFAULT_CONFIG.last_tab).toBe("banana_pro");
    expect(DEFAULT_CONFIG.theme).toBe("auto");
    expect(DEFAULT_CONFIG.language).toBe("en");
    expect(DEFAULT_CONFIG.max_retries).toBe(5);
    expect(DEFAULT_CONFIG.comic_parallel_tasks).toBe(2);
    expect(DEFAULT_CONFIG.video_parallel_tasks).toBe(1);
    expect(DEFAULT_CONFIG.history_items_per_page).toBe(5);
    expect(DEFAULT_CONFIG.video_frames_mode).toBe(false);
  });

  it("serializes with 4-space indentation like json.dump(indent=4)", () => {
    const store = createConfigStore(memoryStorage().storage);
    const text = serializeConfig(store.data);
    expect(text).toContain('\n    "api_base_url": "https://grsai.dakka.com.cn",\n    "api_key": "",\n');
    expect(JSON.parse(text)).toEqual(DEFAULT_CONFIG);
  });
});

describe("config store", () => {
  it("writes the defaults on first launch", async () => {
    const file = memoryStorage();
    const store = createConfigStore(file.storage);
    await store.load();
    expect(file.text).toBe(serializeConfig(DEFAULT_CONFIG));
  });

  it("keeps loaded values, runtime keys and fills in missing default keys", async () => {
    const file = memoryStorage(
      JSON.stringify({ theme: "dark", last_model_tab_banana_pro: "nano-banana-pro" }),
    );
    const store = createConfigStore(file.storage);
    const original = file.text;
    await store.load();
    expect(store.get("theme", "auto")).toBe("dark");
    expect(store.get("max_retries", 0)).toBe(5);
    expect(store.get("last_model_tab_banana_pro", "")).toBe("nano-banana-pro");
    // 只是读入，不改写文件
    expect(file.text).toBe(original);
  });

  it("falls back to defaults on a corrupted file and leaves the file untouched", async () => {
    for (const broken of ["{ not json", "[1, 2]", '"a string"']) {
      const file = memoryStorage(broken);
      const onError = vi.fn();
      const store = createConfigStore(file.storage, { onError });
      await store.load();
      expect(store.get("theme", "auto")).toBe("auto");
      expect(file.text).toBe(broken);
      expect(onError).not.toHaveBeenCalled();
    }
  });

  it("falls back to defaults without writing when the file cannot be read", async () => {
    const onError = vi.fn();
    const write = vi.fn();
    const store = createConfigStore(
      {
        read: () => {
          throw new Error("locked");
        },
        write,
      },
      { onError },
    );
    await store.load();
    expect(store.get("language", "en")).toBe("en");
    expect(write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("returns the fallback only when the key is missing", () => {
    const store = createConfigStore(memoryStorage().storage);
    expect(store.get("api_key")).toBe("");
    expect(store.get("last_model_tab_gpt_image", "gpt-image-2")).toBe("gpt-image-2");
    store.set("last_model_tab_gpt_image", "gpt-image-2-vip");
    expect(store.get("last_model_tab_gpt_image", "")).toBe("gpt-image-2-vip");
  });

  it("notifies subscribers on set and load, and stops after unsubscribing", async () => {
    const file = memoryStorage();
    const store = createConfigStore(file.storage);
    const seen: string[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.get("theme", "auto")));
    store.set("theme", "dark");
    expect(seen).toEqual(["dark"]);
    // 等落盘完成，重新读入时拿到的才是同样的值
    await store.save();
    await store.load();
    expect(seen).toEqual(["dark", "dark"]);
    unsubscribe();
    store.set("theme", "light");
    expect(seen).toEqual(["dark", "dark"]);
  });

  it("coalesces rapid sets and writes them in order", async () => {
    const writes: string[] = [];
    const releases: Array<() => void> = [];
    const storage: ConfigStorage = {
      read: () => null,
      write: (text) =>
        new Promise<void>((resolve) => {
          writes.push(text);
          releases.push(resolve);
        }),
    };
    const store = createConfigStore(storage);

    store.set("theme", "dark");
    store.set("theme", "light");
    store.set("theme", "auto");
    await tick();
    // 第一次写还没完成，后两次只记为待写
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]).theme).toBe("dark");

    releases[0]();
    await tick();
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1]).theme).toBe("auto");

    releases[1]();
    await tick();
    expect(writes).toHaveLength(2);
  });

  it("flush waits for queued writes without writing again", async () => {
    const writes: string[] = [];
    const releases: Array<() => void> = [];
    const storage: ConfigStorage = {
      read: () => null,
      write: (text) =>
        new Promise<void>((resolve) => {
          writes.push(text);
          releases.push(resolve);
        }),
    };
    const store = createConfigStore(storage);

    // 没有在写的直接完成，不碰存储
    await store.flush();
    expect(writes).toHaveLength(0);

    store.set("theme", "dark");
    store.set("theme", "light");
    let flushed = false;
    const flushing = store.flush().then(() => {
      flushed = true;
    });
    await tick();
    // 第二笔还排在后面，这时还不能算写完
    releases[0]();
    await tick();
    expect(flushed).toBe(false);
    expect(writes).toHaveLength(2);
    releases[1]();
    await flushing;
    expect(flushed).toBe(true);
    expect(JSON.parse(writes[1]).theme).toBe("light");
  });

  it("reports a failed write instead of throwing", async () => {
    const onError = vi.fn();
    const store = createConfigStore(
      {
        read: () => null,
        write: () => Promise.reject(new Error("disk full")),
      },
      { onError },
    );
    await expect(store.load()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
