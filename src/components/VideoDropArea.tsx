/**
 * 参考视频区（仿照 AudioDropArea）：紧凑的文件表格，文件名（悬停滚动）/ 可选「起始秒数」/ 可选「音轨」/ 预览·移除。
 * 时长通过隐藏的 video 元素逐个探测元数据，用于提交前校验总时长和起始秒数上限；解不了码时时长记为 null。
 */
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button, Checkbox, Input, Tooltip } from "@fluentui/react-components";
import { Delete20Regular, Play20Regular, Video20Regular } from "@fluentui/react-icons";
import type { VideoReferenceOption } from "../core/api";
import { tr } from "../i18n";
import { useTr } from "../hooks/useLanguage";
import { platform } from "../platform";
import { runAsync } from "../platform/async";
import { formatDuration, isDragOver, isSupportedVideo, normalizePath, parseFileFilter, pickOnce, planSlots } from "./dropAreaLogic";
import type { VideoDropAreaProps, VideoReference } from "./dropAreaTypes";
import { MarqueeText } from "./MarqueeText";
import { notice } from "./Notice";
import "./VideoDropArea.css";

/** 单个视频文件的时长探测超时兜底。 */
const PROBE_TIMEOUT_MS = 4000;

/** 解析起始秒数输入：留空为 null（不传）；严格整数返回整数；其余返回 NaN 交由提交前校验拦截。 */
function parseStartSeconds(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^-?\d+$/.test(trimmed)) return Number.NaN;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : Number.NaN;
}

function loadVideoDuration(video: HTMLVideoElement, url: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let timer = 0;
    function finish(seconds: number | null): void {
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("error", onAbort);
      video.removeEventListener("abort", onAbort);
      resolve(seconds);
    }
    function onReady(): void {
      const d = video.duration;
      finish(Number.isFinite(d) && d > 0 ? d : null);
    }
    function onAbort(): void {
      finish(null);
    }
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("error", onAbort);
    video.addEventListener("abort", onAbort);
    timer = window.setTimeout(() => finish(null), timeoutMs);
    video.src = url;
    video.load();
  });
}

export default function VideoDropArea({ ref, maxVideos, fields, onChange, className }: VideoDropAreaProps) {
  const t = useTr();
  const rootRef = useRef<HTMLDivElement>(null);
  const probeVideoRef = useRef<HTMLVideoElement>(null);
  const itemsRef = useRef<VideoReference[]>([]);
  const [items, setItems] = useState<VideoReference[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const latest = useRef({ maxVideos, onChange });
  useEffect(() => {
    latest.current = { maxVideos, onChange };
  });

  const probeRef = useRef({ queue: [] as string[], active: false, run: 0 });
  const allowedRef = useRef(new Set<string>());

  const showStart = fields?.includes("startSeconds") === true;
  const showAudio = fields?.includes("requireAudio") === true;

  const commit = useCallback((next: VideoReference[]) => {
    itemsRef.current = next;
    setItems(next);
    latest.current.onChange?.(next);
  }, []);

  const allow = useCallback(async (path: string): Promise<void> => {
    if (allowedRef.current.has(path)) return;
    await platform.media.allow([path]);
    allowedRef.current.add(path);
  }, []);

  const pauseProbe = useCallback(() => {
    const probe = probeRef.current;
    probe.active = false;
    probe.run += 1;
  }, []);

  const probeNext = useCallback(async (): Promise<void> => {
    const probe = probeRef.current;
    const video = probeVideoRef.current;
    const path: string | undefined = probe.queue[0];
    if (!video || probe.active || path === undefined) return;
    probe.active = true;
    const run = ++probe.run;
    const interrupted = () => run !== probe.run;
    let seconds: number | null = null;
    try {
      await allow(path);
      if (interrupted()) return;
      const exists = await platform.fs.isFile(path);
      if (interrupted()) return;
      if (exists) seconds = await loadVideoDuration(video, platform.media.url(path), PROBE_TIMEOUT_MS);
    } catch {
      // 探测失败（例如 mock 假视频）按时长未知处理
    }
    if (interrupted()) return;
    if (seconds !== null) {
      const next = itemsRef.current.map((item) =>
        item.path === path ? { ...item, durationSeconds: seconds } : item,
      );
      commit(next);
    }
    probe.queue.shift();
    probe.active = false;
    void probeNext();
  }, [allow, commit]);

  const removeVideo = useCallback(
    (path: string) => {
      const probe = probeRef.current;
      const probingIt = probe.active && probe.queue[0] === path;
      probe.queue = probe.queue.filter((queued) => queued !== path);
      commit(itemsRef.current.filter((item) => item.path !== path));
      if (probingIt) {
        pauseProbe();
        void probeNext();
      }
    },
    [commit, pauseProbe, probeNext],
  );

  const clearVideos = useCallback(() => {
    pauseProbe();
    probeRef.current.queue = [];
    if (itemsRef.current.length > 0) commit([]);
  }, [commit, pauseProbe]);

  const addVideosInternal = useCallback(
    (
      candidates: readonly string[],
      showLimitWarning: boolean,
      itemOptions?: readonly (VideoReferenceOption | null | undefined)[] | null,
    ): number => {
      const max = latest.current.maxVideos;
      const optionByPath = new Map<string, VideoReferenceOption>();
      const normalized: string[] = [];
      for (let index = 0; index < candidates.length; index += 1) {
        const raw = candidates[index];
        if (!raw) continue;
        const norm = normalizePath(raw);
        normalized.push(norm);
        const opt = itemOptions?.[index];
        if (opt && !optionByPath.has(norm)) optionByPath.set(norm, opt);
      }
      const existingPaths = itemsRef.current.map((item) => item.path);
      const plan = planSlots(existingPaths, normalized, max, isSupportedVideo);
      if (plan.full) {
        if (showLimitWarning) notice("warning", tr("common.limit_reached"), tr("video.msg.video_limit_reached", { max }));
        return 0;
      }
      if (plan.toAdd.length === 0) return 0;
      const added: VideoReference[] = plan.toAdd.map((path) => {
        const opt = optionByPath.get(path);
        const startSeconds = opt?.startSeconds !== undefined ? opt.startSeconds : 0;
        return {
          path,
          startSeconds,
          startSecondsText: startSeconds === null ? "" : String(startSeconds),
          requireAudio: opt?.requireAudio === true,
          durationSeconds: null,
        };
      });
      commit([...itemsRef.current, ...added]);
      probeRef.current.queue.push(...plan.toAdd);
      for (const path of plan.toAdd) runAsync(allow(path));
      void probeNext();
      if (plan.skipped > 0 && showLimitWarning) {
        notice("warning", tr("common.limit_reached"), tr("video.msg.video_limit_skipped", { max, count: plan.skipped }));
      }
      return plan.toAdd.length;
    },
    [allow, commit, probeNext],
  );

  const openFileDialog = useCallback(async () => {
    const picked = await pickOnce(() =>
      platform.dialog.pickFiles({
        title: tr("video.dialog.open_videos"),
        multiple: true,
        filters: [parseFileFilter(tr("video.dialog.video_filter"))],
      }),
    );
    addVideosInternal(picked, true);
  }, [addVideosInternal]);

  useEffect(() => {
    const unsubscribe = platform.dragDrop.subscribe((event) => {
      const inside = isDragOver(rootRef.current, event);
      if (event.type === "drop") {
        setDragOver(false);
        if (inside) addVideosInternal(event.paths, true);
        return;
      }
      setDragOver(event.type !== "leave" && inside);
    });
    return unsubscribe;
  }, [addVideosInternal]);

  useImperativeHandle(
    ref,
    () => ({
      getVideos: () => itemsRef.current.map((item) => ({ ...item })),
      addVideos: async (paths, options) => {
        addVideosInternal(paths, options?.showLimitWarning ?? false, options?.itemOptions);
      },
      clearVideos,
      openFileDialog,
    }),
    [addVideosInternal, clearVideos, openFileDialog],
  );

  const updateItem = (path: string, patch: Partial<VideoReference>) => {
    commit(itemsRef.current.map((item) => (item.path === path ? { ...item, ...patch } : item)));
  };

  const hint = t("video.add_video", { max: maxVideos });

  return (
    <div
      ref={rootRef}
      className={["video-drop-area", dragOver ? "video-drop-area--dragover" : "", className ?? ""].filter(Boolean).join(" ")}
    >
      {items.length === 0 ? (
        <Button
          appearance="transparent"
          className="video-drop-area__hint"
          icon={<Video20Regular />}
          aria-label={hint}
          onClick={() => runAsync(openFileDialog())}
        >
          {hint}
        </Button>
      ) : (
        <div className="video-drop-area__table-wrap">
          <table
            className={
              showStart || showAudio
                ? "video-drop-area__table video-drop-area__table--wide"
                : "video-drop-area__table"
            }
          >
            <colgroup>
              <col />
              <col className="video-drop-area__col-duration" />
              {showStart ? <col className="video-drop-area__col-start" /> : null}
              {showAudio ? <col className="video-drop-area__col-audio" /> : null}
              <col className="video-drop-area__col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{t("audio.column.name")}</th>
                <th scope="col">{t("audio.column.duration")}</th>
                {showStart ? <th scope="col">{t("video.column.video_start")}</th> : null}
                {showAudio ? <th scope="col">{t("video.column.video_audio")}</th> : null}
                <th scope="col">{t("audio.column.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const startText =
                  item.startSecondsText ?? (item.startSeconds === null ? "" : String(item.startSeconds));
                const durationMs =
                  typeof item.durationSeconds === "number" && Number.isFinite(item.durationSeconds) && item.durationSeconds > 0
                    ? Math.trunc(item.durationSeconds * 1000)
                    : undefined;
                return (
                  <tr key={item.path}>
                    <td title={item.path}>
                      <MarqueeText text={platform.paths.basename(item.path)} />
                    </td>
                    <td className="video-drop-area__cell-duration" title={t("audio.column.duration")}>
                      {formatDuration(durationMs)}
                    </td>
                    {showStart ? (
                      <td className="video-drop-area__cell-center">
                        <Input
                          size="small"
                          className="video-drop-area__start-input"
                          value={startText}
                          aria-label={t("video.column.video_start")}
                          onChange={(_event, data) =>
                            updateItem(item.path, {
                              startSecondsText: data.value,
                              startSeconds: parseStartSeconds(data.value),
                            })
                          }
                        />
                      </td>
                    ) : null}
                    {showAudio ? (
                      <td className="video-drop-area__cell-center">
                        <Checkbox
                          checked={item.requireAudio}
                          aria-label={t("video.column.video_audio")}
                          onChange={(_event, data) => updateItem(item.path, { requireAudio: data.checked === true })}
                        />
                      </td>
                    ) : null}
                    <td className="video-drop-area__cell-actions">
                      <div className="video-drop-area__actions">
                        <Tooltip content={t("video.tooltip.preview_video")} relationship="label">
                          <Button
                            appearance="transparent"
                            size="small"
                            className="video-drop-area__action"
                            icon={<Play20Regular />}
                            aria-label={t("video.tooltip.preview_video")}
                            onClick={() => runAsync(platform.opener.openPath(item.path))}
                          />
                        </Tooltip>
                        <Tooltip content={t("video.tooltip.remove_video")} relationship="label">
                          <Button
                            appearance="transparent"
                            size="small"
                            className="video-drop-area__action"
                            icon={<Delete20Regular />}
                            aria-label={t("video.tooltip.remove_video")}
                            onClick={() => removeVideo(item.path)}
                          />
                        </Tooltip>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <video ref={probeVideoRef} className="video-drop-area__probe" preload="metadata" muted />
    </div>
  );
}
