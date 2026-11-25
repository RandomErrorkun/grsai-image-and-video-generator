import { describe, expect, it } from "vitest";
import {
  AUDIO_EXTENSIONS,
  containsPoint,
  formatDuration,
  IMAGE_EXTENSIONS,
  isDragOver,
  isPasteShortcut,
  isSupportedAudio,
  isSupportedImage,
  normalizePath,
  parseFileFilter,
  pickOnce,
  pickPasteTarget,
  planSlots,
} from "./dropAreaLogic";

const always = () => true;

describe("格式判断", () => {
  it("图片认五个扩展名，音频认六个，与源项目的 SUPPORTED_EXTENSIONS 一致", () => {
    expect([...IMAGE_EXTENSIONS]).toEqual([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);
    expect([...AUDIO_EXTENSIONS]).toEqual([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);
  });

  it("不分大小写，按整个路径的后缀判断", () => {
    expect(isSupportedImage("C:\\pics\\a.PNG")).toBe(true);
    expect(isSupportedImage("/tmp/x.jpeg")).toBe(true);
    expect(isSupportedImage("C:\\pics\\a.gif")).toBe(false);
    expect(isSupportedImage("C:\\pics\\a.png.txt")).toBe(false);
    expect(isSupportedAudio("C:\\a.M4A")).toBe(true);
    expect(isSupportedAudio("C:\\a.mp3")).toBe(true);
    expect(isSupportedAudio("C:\\a.png")).toBe(false);
  });

  it("空串不算，别的类型之外的空白照常判断", () => {
    expect(isSupportedImage("")).toBe(false);
    expect(isSupportedAudio("")).toBe(false);
    expect(isSupportedImage("a.png ")).toBe(false);
    expect(isSupportedImage(".png")).toBe(true);
  });
});

describe("路径规整", () => {
  // 期望值是 Python 3.11 的 ntpath.normpath 逐条跑出来的
  it.each([
    ["C:/a//b/./c/../d.wav", "C:\\a\\b\\d.wav"],
    ["a/b/", "a\\b"],
    ["", "."],
    ["C:\\", "C:\\"],
    ["C:/", "C:\\"],
    ["C:foo", "C:foo"],
    ["C:..\\a", "C:..\\a"],
    ["C:\\..\\a", "C:\\a"],
    ["C:\\..", "C:\\"],
    ["/foo", "\\foo"],
    ["\\\\server\\share\\a\\..\\b", "\\\\server\\share\\b"],
    ["\\\\server\\share", "\\\\server\\share"],
    ["\\\\server\\share\\..\\x", "\\\\server\\share\\x"],
    ["\\\\server\\share\\sub\\..\\..\\keep.wav", "\\\\server\\share\\keep.wav"],
    ["\\\\a\\..\\b", "\\\\a\\..\\b"],
    ["\\\\a", "\\\\a"],
    ["..\\a", "..\\a"],
    ["a\\..", "."],
    ["a/../..", ".."],
    ["A.TXT", "A.TXT"],
    ["C:\\Users\\Me\\Music\\..\\Voice.MP3", "C:\\Users\\Me\\Voice.MP3"],
    ["./x.wav", "x.wav"],
    ["C:\\a\\..\\..\\b", "C:\\b"],
    ["C:\\Users\\Me\\..\\..\\..\\v.mp3", "C:\\v.mp3"],
    ["a\\\\\\\\b", "a\\b"],
    ["..", ".."],
    [".", "."],
    ["C:\\.", "C:\\"],
    ["C:/./", "C:\\"],
  ])("normpath(%j) 得 %j", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });
});

describe("名额分配", () => {
  it("装得下就全收，保持顺序", () => {
    expect(planSlots([], ["a", "b"], 3, always)).toEqual({ toAdd: ["a", "b"], skipped: 0, full: false });
  });

  it("装不下的截断，并报出跳过了几个", () => {
    expect(planSlots(["x"], ["a", "b", "c"], 3, always)).toEqual({ toAdd: ["a", "b"], skipped: 1, full: false });
  });

  it("一个名额都没有时算已满，哪怕送来的全是重复或不支持的路径", () => {
    expect(planSlots(["x"], ["x"], 1, always)).toEqual({ toAdd: [], skipped: 0, full: true });
    expect(planSlots(["x"], ["x.txt"], 1, (path) => path.endsWith(".png"))).toEqual({ toAdd: [], skipped: 0, full: true });
    // 上限缩到比已有张数还小之后也是满的，已有的不裁
    expect(planSlots(["a", "b", "c"], ["d"], 1, always).full).toBe(true);
  });

  it("已经在列表里的、这次重复的、不支持的都只算一次或不算，不占名额", () => {
    // 已有 1 张、上限 3：剩 2 个名额，正好收下 a 和 b
    expect(planSlots(["x"], ["x", "a", "a", "x.txt", "b"], 3, (path) => path !== "x.txt")).toEqual({
      toAdd: ["a", "b"],
      skipped: 0,
      full: false,
    });
    // 只剩 1 个名额时：重复的 a 不算溢出，只有 b 被跳过
    expect(planSlots(["x"], ["x", "a", "a", "x.txt", "b"], 2, (path) => path !== "x.txt")).toEqual({
      toAdd: ["a"],
      skipped: 1,
      full: false,
    });
    expect(planSlots([], ["a", "a", "a"], 3, always).toAdd).toEqual(["a"]);
  });

  it("名额够但一个能收的都没有时什么都不报", () => {
    expect(planSlots([], ["x.txt"], 3, (path) => path.endsWith(".png"))).toEqual({ toAdd: [], skipped: 0, full: false });
    expect(planSlots([], [], 0, always)).toEqual({ toAdd: [], skipped: 0, full: false });
  });

  it("先去重再数名额：重复的不会被算成溢出", () => {
    expect(planSlots([], ["a", "a", "a", "b"], 2, always)).toEqual({ toAdd: ["a", "b"], skipped: 0, full: false });
  });
});

describe("时长格式", () => {
  // 取整的期望值是 Python round() 的结果：一半向偶数舍入
  it.each([
    [undefined, "--:--"],
    [0, "--:--"],
    [-5, "--:--"],
    [Number.NaN, "--:--"],
    [83000, "01:23"],
    [59999, "01:00"],
    [59499, "00:59"],
    [3600000, "60:00"],
    [1500, "00:02"],
    [2500, "00:02"],
    [3500, "00:04"],
    [4500, "00:04"],
    [5500, "00:06"],
    [6500, "00:06"],
  ])("%s 毫秒显示成 %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe("对话框筛选文案", () => {
  it("拆出名字和扩展名，扩展名不带星号和点", () => {
    expect(parseFileFilter("Image files (*.jpg *.jpeg *.png *.webp)")).toEqual({
      name: "Image files",
      extensions: ["jpg", "jpeg", "png", "webp"],
    });
    expect(parseFileFilter("Audio files (*.mp3 *.wav *.m4a *.aac *.flac *.ogg)")).toEqual({
      name: "Audio files",
      extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg"],
    });
    expect(parseFileFilter("Images (*.PNG)")).toEqual({ name: "Images", extensions: ["png"] });
  });

  it("没有括号的文案按全部文件处理", () => {
    expect(parseFileFilter(" All files ")).toEqual({ name: "All files", extensions: [] });
    expect(parseFileFilter("Broken (*.png")).toEqual({ name: "Broken (*.png", extensions: [] });
  });

  it("中文文案同样能拆", () => {
    expect(parseFileFilter("图片文件 (*.jpg *.png)")).toEqual({ name: "图片文件", extensions: ["jpg", "png"] });
  });
});

describe("Ctrl+V 的判断", () => {
  const keys = (key: string, modifiers: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  });

  it("Ctrl+V 和 Command+V 都算，大小写锁定造成的 V 也算", () => {
    expect(isPasteShortcut(keys("v", { ctrlKey: true }))).toBe(true);
    expect(isPasteShortcut(keys("V", { ctrlKey: true }))).toBe(true);
    expect(isPasteShortcut(keys("v", { metaKey: true }))).toBe(true);
  });

  it("同时按着 Shift 或 Alt 的不算，别的键不算", () => {
    expect(isPasteShortcut(keys("V", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPasteShortcut(keys("v", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPasteShortcut(keys("c", { ctrlKey: true }))).toBe(false);
    expect(isPasteShortcut(keys("v"))).toBe(false);
  });
});

describe("落点判断", () => {
  const rect = { left: 10, top: 20, right: 110, bottom: 70 };

  it("左上角在内，右下角的边线在外", () => {
    expect(containsPoint(rect, 10, 20)).toBe(true);
    expect(containsPoint(rect, 109.5, 69.5)).toBe(true);
    expect(containsPoint(rect, 110, 50)).toBe(false);
    expect(containsPoint(rect, 50, 70)).toBe(false);
    expect(containsPoint(rect, 9, 50)).toBe(false);
  });

  it("隐藏后量出来是零尺寸的矩形，任何点都不在内", () => {
    expect(containsPoint({ left: 0, top: 0, right: 0, bottom: 0 }, 0, 0)).toBe(false);
    expect(containsPoint({ left: 0, top: 0, right: 0, bottom: 0 }, 40, 40)).toBe(false);
  });

  it("拖放的光标落在元素上才算；没有元素或元素量不到矩形时不算", () => {
    const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom }) as DOMRect;
    const shown = { getClientRects: () => [{}] as unknown as DOMRectList, getBoundingClientRect: () => rect(100, 200, 300, 260) };
    const hidden = { getClientRects: () => [] as unknown as DOMRectList, getBoundingClientRect: () => rect(0, 0, 0, 0) };
    expect(isDragOver(shown, { position: { x: 150, y: 230 } })).toBe(true);
    expect(isDragOver(shown, { position: { x: 99, y: 230 } })).toBe(false);
    expect(isDragOver(shown, { position: { x: 150, y: 260 } })).toBe(false);
    expect(isDragOver(hidden, { position: { x: 150, y: 230 } })).toBe(false);
    expect(isDragOver(null, { position: { x: 150, y: 230 } })).toBe(false);
  });
});

describe("粘贴目标", () => {
  it("隐藏的不参与", () => {
    const hidden = { visible: false, freeSlots: 3 };
    const shown = { visible: true, freeSlots: 0 };
    expect(pickPasteTarget([hidden, shown])).toBe(shown);
    expect(pickPasteTarget([hidden])).toBeUndefined();
  });

  it("有名额的优先，都满了就取排在最前的", () => {
    const first = { visible: true, freeSlots: 0 };
    const second = { visible: true, freeSlots: 1 };
    const third = { visible: true, freeSlots: 5 };
    expect(pickPasteTarget([first, second, third])).toBe(second);
    expect(pickPasteTarget([first, { visible: true, freeSlots: 0 }])).toBe(first);
  });

  it("排在前面的有名额时不往后找，与首尾帧的空槽位顺序一致", () => {
    const first = { visible: true, freeSlots: 1 };
    const last = { visible: true, freeSlots: 1 };
    expect(pickPasteTarget([first, last])).toBe(first);
    expect(pickPasteTarget([{ visible: true, freeSlots: 0 }, last])).toBe(last);
  });
});

describe("pickOnce", () => {
  it("opens one dialog at a time and ignores a second click while the first is open", async () => {
    let finishFirst: (paths: string[]) => void = () => {};
    let opened = 0;
    const open = () => {
      opened += 1;
      return new Promise<readonly string[]>((resolve) => {
        finishFirst = resolve;
      });
    };
    const first = pickOnce(open);
    expect(await pickOnce(open)).toEqual([]);
    expect(opened).toBe(1);
    finishFirst(["a.png"]);
    expect(await first).toEqual(["a.png"]);
    // 关掉之后可以再开
    finishFirst = (paths) => paths;
    const third = pickOnce(async () => ["b.png"]);
    expect(await third).toEqual(["b.png"]);
  });

  it("lets the next dialog open even when the first one fails", async () => {
    await expect(
      pickOnce(async () => {
        throw new Error("broken");
      }),
    ).rejects.toThrow("broken");
    expect(await pickOnce(async () => ["c.png"])).toEqual(["c.png"]);
  });
});
