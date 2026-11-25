/**
 * 参考图区（对应 ui/components/image_drop_area.py）。
 * 路径列表由组件自己保管，页面用 ref 或 onChange 取；拖放、点选、粘贴、addImage 四条路都走同一套名额与去重。
 * 标题栏上的粘贴、清空按钮在源项目里属于页面，这里只提供 pasteFromClipboard 和 clearImages 两个动作。
 */
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type MouseEvent } from "react";
import { Button } from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import { tr } from "../i18n";
import { useTr } from "../hooks/useLanguage";
import { platform } from "../platform";
import { runAsync } from "../platform/async";
import type { ClipboardSnapshot } from "../platform/types";
import { isDragOver, isPasteShortcut, isSupportedImage, parseFileFilter, pickOnce, pickPasteTarget, planSlots } from "./dropAreaLogic";
import type { ImageDropAreaProps } from "./dropAreaTypes";
import { notice } from "./Notice";
import "./ImageDropArea.css";

/** 页面上挂着的每一个参考图区。三个页面都常驻，Ctrl+V 靠它只落进一个区。 */
interface PasteTarget {
  element: HTMLDivElement | null;
  freeSlots(): number;
  paste(): Promise<void>;
}

const pasteTargets = new Set<PasteTarget>();

/** 所在的页面隐藏（display: none）时量不到矩形，Ctrl+V 不该落到这里。 */
function isShown(element: HTMLElement | null): boolean {
  return element !== null && element.getClientRects().length > 0;
}

let shortcutBound = false;

/** 全页面只挂一个按键监听，每个区各自判断自己是不是选中的那个。 */
function listenForPaste(): void {
  if (shortcutBound) return;
  shortcutBound = true;
  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.defaultPrevented || !isPasteShortcut(event)) return;
    const target = pickPasteTarget(
      [...pasteTargets].map((area) => ({ visible: isShown(area.element), freeSlots: area.freeSlots(), area })),
    );
    // 剪贴板要问了才知道是图、文件还是文字，这时按键的默认动作早已过去：
    // 文字照常落进聚焦的输入框，这里只对图和文件列表有反应
    runAsync(target ? target.area.paste() : Promise.resolve());
  });
}

export default function ImageDropArea({ ref, maxImages, placeholderKey, onChange, className }: ImageDropAreaProps) {
  const t = useTr();
  const rootRef = useRef<HTMLDivElement>(null);
  // 列表的本体在 ref 里，getPaths 和各个回调读到的永远是最新的一份；state 只管触发重绘
  const pathsRef = useRef<string[]>([]);
  const [paths, setPaths] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // 事件回调里要读最新的上限和 onChange，各留一份
  const latest = useRef({ maxImages, onChange });
  useEffect(() => {
    latest.current = { maxImages, onChange };
  });

  const commit = useCallback((next: string[]) => {
    pathsRef.current = next;
    setPaths(next);
    latest.current.onChange?.(next);
  }, []);

  // 对应 add_images。上限只管之后还能不能加：视频页把上限改小时，已有的图照源项目不裁
  const addImages = useCallback((candidates: readonly string[], showLimitWarning: boolean): number => {
    const plan = planSlots(pathsRef.current, candidates, latest.current.maxImages, isSupportedImage);
    const max = latest.current.maxImages;
    if (plan.full) {
      if (showLimitWarning) notice("warning", tr("common.limit_reached"), tr("drop.msg.limit_reached", { max }));
      return 0;
    }
    if (plan.toAdd.length === 0) return 0;
    commit([...pathsRef.current, ...plan.toAdd]);
    if (plan.skipped > 0 && showLimitWarning) {
      notice("warning", tr("common.limit_reached"), tr("drop.msg.limit_skipped", { max, count: plan.skipped }));
    }
    return plan.toAdd.length;
  }, [commit]);

  const clearImages = useCallback(() => {
    if (pathsRef.current.length > 0) commit([]);
  }, [commit]);

  const removeImage = useCallback(
    (path: string) => {
      if (pathsRef.current.includes(path)) commit(pathsRef.current.filter((item) => item !== path));
    },
    [commit],
  );

  // 对应 paste_from_clipboard。源项目在这里先看位图、再看文件列表，两者都没有才提示剪贴板里没有图片
  const pasteSnapshot = useCallback(
    (snapshot: ClipboardSnapshot): void => {
      if (snapshot.kind === "image") {
        if (addImages([snapshot.path], true)) notice("success", tr("common.pasted"), tr("drop.msg.pasted_image"));
        return;
      }
      if (snapshot.kind === "files") {
        if (addImages(snapshot.paths, true)) notice("success", tr("common.pasted"), tr("drop.msg.pasted_files"));
        else notice("warning", tr("common.warning"), tr("drop.msg.no_supported_image"));
        return;
      }
      notice("warning", tr("common.warning"), tr("drop.msg.no_image"));
    },
    [addImages],
  );

  const pasteFromClipboard = useCallback(async () => {
    pasteSnapshot(await platform.clipboard.read());
  }, [pasteSnapshot]);

  // 对应 mousePressEvent：点一下空白处就打开对话框；对话框开着时再点不开第二个
  const pickFiles = useCallback(async () => {
    const picked = await pickOnce(() =>
      platform.dialog.pickFiles({
        title: tr("drop.dialog.open_files"),
        multiple: true,
        filters: [parseFileFilter(tr("drop.dialog.filter"))],
      }),
    );
    addImages(picked, true);
  }, [addImages]);

  // 拖放由平台层接管，网页收不到浏览器自己的 drop 事件
  useEffect(() => {
    const area: PasteTarget = {
      element: rootRef.current,
      freeSlots: () => Math.max(latest.current.maxImages - pathsRef.current.length, 0),
      paste: pasteFromClipboard,
    };
    pasteTargets.add(area);
    listenForPaste();
    const unsubscribe = platform.dragDrop.subscribe((event) => {
      // 光标落在自己身上才高亮、才接收
      const inside = isDragOver(rootRef.current, event);
      if (event.type === "drop") {
        setDragOver(false);
        if (inside) addImages(event.paths, true);
        return;
      }
      setDragOver(event.type !== "leave" && inside);
    });
    return () => {
      pasteTargets.delete(area);
      unsubscribe();
    };
  }, [addImages, pasteFromClipboard]);

  useImperativeHandle(
    ref,
    () => ({
      getPaths: () => [...pathsRef.current],
      addImage: async (path) => {
        addImages([path], true);
      },
      clearImages,
      pasteFromClipboard,
    }),
    [addImages, clearImages, pasteFromClipboard],
  );

  const openPicker = () => runAsync(pickFiles());

  return (
    <div
      ref={rootRef}
      className={["image-drop-area", dragOver ? "image-drop-area--dragover" : "", className ?? ""].filter(Boolean).join(" ")}
      onClick={openPicker}
    >
      {paths.length === 0 ? (
        <button type="button" className="image-drop-area__placeholder" aria-label={t("drop.dialog.open_files")}>
          <span>{placeholderKey ? t(placeholderKey) : t("drop.placeholder", { max: maxImages })}</span>
        </button>
      ) : (
        <div className="image-drop-area__scroll" role="list">
          {paths.map((path) => (
            <ImageThumbnail key={path} path={path} onRemove={removeImage} />
          ))}
        </div>
      )}
    </div>
  );
}

interface ImageThumbnailProps {
  path: string;
  onRemove(path: string): void;
}

/**
 * 一张缩略图：宽随滚动区，高按原图比例（最小 80），左上角是移除按钮。
 * 文件读不到时只剩带边框的空框，与源项目一致；读得到再放行、再交给 img。
 */
function ImageThumbnail({ path, onRemove }: ImageThumbnailProps) {
  const t = useTr();
  const [image, setImage] = useState<{ src: string; ratio: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    runAsync(
      (async () => {
        // Tauri 里本地文件要先放行才读得到；先放行再查存在，没放行时 stat 本身就会被拒
        await platform.media.allow([path]);
        if (cancelled || !(await platform.fs.isFile(path))) return;
        if (!cancelled) setImage({ src: platform.media.url(path), ratio: 1 });
      })(),
    );
    return () => {
      cancelled = true;
    };
  }, [path]);

  const onRemoveClick = (event: MouseEvent<HTMLButtonElement>) => {
    // 移除只是移除，不要落进外层的「点一下选图」
    event.stopPropagation();
    onRemove(path);
  };

  return (
    <div className="image-thumb" role="listitem">
      <div className="image-thumb__frame" style={{ aspectRatio: String(image?.ratio ?? 1) }}>
        {image ? (
          <img
            src={image.src}
            alt=""
            draggable={false}
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget;
              setImage((current) =>
                current && naturalHeight > 0 ? { ...current, ratio: naturalWidth / naturalHeight } : current,
              );
            }}
            onError={() => setImage(null)}
          />
        ) : null}
      </div>
      <Button
        appearance="transparent"
        size="small"
        className="image-thumb__remove"
        icon={<Dismiss20Regular />}
        aria-label={t("drop.remove_image")}
        onClick={onRemoveClick}
      />
    </div>
  );
}
