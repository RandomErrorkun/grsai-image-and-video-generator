/**
 * 参考音频区（对应 ui/components/audio_drop_area.py）：紧凑的文件表格，文件名 / 时长 / 播放·停止·移除。
 * 所有行共用一个 audio 元素，所以同时只有一行在响；时长是排队逐个加载元数据探出来的，探不到显示 --:--。
 * 标题栏上的添加、清空按钮在源项目里属于页面，这里对应 openFileDialog 和 clearAudios。
 */
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type SyntheticEvent } from "react";
import { Button, Tooltip } from "@fluentui/react-components";
import { Delete20Regular, Dismiss20Regular, MusicNote220Regular, Pause20Regular, Play20Regular } from "@fluentui/react-icons";
import { tr } from "../i18n";
import { useTr } from "../hooks/useLanguage";
import { platform } from "../platform";
import { runAsync } from "../platform/async";
import { formatDuration, isDragOver, isSupportedAudio, normalizePath, parseFileFilter, pickOnce, planSlots } from "./dropAreaLogic";
import type { AudioDropAreaProps } from "./dropAreaTypes";
import { MarqueeText } from "./MarqueeText";
import { notice } from "./Notice";
import "./AudioDropArea.css";

/** 单个文件的时长探测超时兜底，与源项目一致。 */
const PROBE_TIMEOUT_MS = 4000;

/**
 * 让共用播放器去加载一个文件的元数据，返回时长（秒）；出错、被打断或超时返回 null。
 * 之后播放器归谁由调用方决定。
 */
function loadMetadata(audio: HTMLAudioElement, url: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let timer = 0;
    function finish(seconds: number | null): void {
      window.clearTimeout(timer);
      audio.removeEventListener("loadedmetadata", onReady);
      audio.removeEventListener("error", onAbort);
      audio.removeEventListener("abort", onAbort);
      resolve(seconds);
    }
    function onReady(): void {
      finish(audio.duration);
    }
    function onAbort(): void {
      finish(null);
    }
    audio.addEventListener("loadedmetadata", onReady);
    audio.addEventListener("error", onAbort);
    audio.addEventListener("abort", onAbort);
    timer = window.setTimeout(() => finish(null), timeoutMs);
    audio.src = url;
    audio.load();
  });
}

export default function AudioDropArea({ ref, maxFiles, onChange, className }: AudioDropAreaProps) {
  const t = useTr();
  const rootRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // 列表的本体在 ref 里，getPaths 和各个回调读到的永远是最新的一份；state 只管触发重绘
  const pathsRef = useRef<string[]>([]);
  const [paths, setPaths] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // 路径到时长毫秒；没有或为 0 的显示 --:--
  const [durations, setDurations] = useState<Record<string, number>>({});
  // 正在播放（或暂停着）的那一行，对应 _playing_path
  const playingPathRef = useRef<string | null>(null);
  const [playingPath, setPlayingPathState] = useState<string | null>(null);
  // 播放器此刻在不在响；暂停着的那一行图标仍是播放，与源项目一致
  const [audible, setAudible] = useState(false);
  // 事件回调里要读最新的上限和 onChange，各留一份
  const latest = useRef({ maxFiles, onChange });
  useEffect(() => {
    latest.current = { maxFiles, onChange };
  });
  // 探测队列。run 每打断一次就加一，让还在等结果的旧探测作废
  const probeRef = useRef({ queue: [] as string[], active: false, run: 0 });
  const allowedRef = useRef(new Set<string>());

  const setPlayingPath = useCallback((path: string | null) => {
    playingPathRef.current = path;
    setPlayingPathState(path);
  }, []);

  const commit = useCallback((next: string[]) => {
    pathsRef.current = next;
    setPaths(next);
    latest.current.onChange?.(next);
  }, []);

  /** 只记大于 0 的有限时长，对应 _on_duration_changed；0 表示探不到，且不去覆盖已经探到的值。 */
  const recordDuration = useCallback((path: string, seconds: number) => {
    const ms = Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds * 1000) : 0;
    setDurations((previous) => {
      if (ms === 0 ? previous[path] !== undefined : previous[path] === ms) return previous;
      return { ...previous, [path]: ms };
    });
  }, []);

  const allow = useCallback(async (path: string): Promise<void> => {
    if (allowedRef.current.has(path)) return;
    await platform.media.allow([path]);
    allowedRef.current.add(path);
  }, []);

  /** 让正在等结果的那一轮探测作废；队列留着，之后接着探。 */
  const pauseProbe = useCallback(() => {
    const probe = probeRef.current;
    probe.active = false;
    probe.run += 1;
  }, []);

  /** 探测队首那个文件的时长。播放中不抢播放器，停下后由 stopPlayback 和播完的事件再叫它。 */
  const probeNext = useCallback(async (): Promise<void> => {
    const probe = probeRef.current;
    const audio = audioRef.current;
    const path: string | undefined = probe.queue[0];
    if (!audio || probe.active || playingPathRef.current !== null || path === undefined) return;
    probe.active = true;
    const run = ++probe.run;
    // 期间被播放或清理打断：播放器已经易主，这一轮的结果不再作数
    const interrupted = () => run !== probe.run;
    let seconds: number | null = null;
    try {
      // Tauri 里本地文件要先放行才读得到；先放行再查存在，没放行时 stat 本身就会被拒
      await allow(path);
      if (interrupted()) return;
      const exists = await platform.fs.isFile(path);
      if (interrupted()) return;
      if (exists) seconds = await loadMetadata(audio, platform.media.url(path), PROBE_TIMEOUT_MS);
    } catch (error) {
      console.error(error);
    }
    if (interrupted()) return;
    recordDuration(path, seconds ?? 0);
    probe.queue.shift();
    probe.active = false;
    void probeNext();
  }, [allow, recordDuration]);

  /** 播放没起来（文件解不了码之类）：这一行退回播放图标，原因记进控制台。 */
  const onPlayFailed = useCallback(
    (error: unknown) => {
      console.error(error);
      setPlayingPath(null);
    },
    [setPlayingPath],
  );

  const playFrom = useCallback(
    async (path: string) => {
      const audio = audioRef.current;
      if (!audio) return;
      try {
        // 加入时已经提前放行过，通常这里不用等，play() 仍留在点击事件里
        await allow(path);
      } catch (error) {
        onPlayFailed(error);
        return;
      }
      audio.src = platform.media.url(path);
      audio.load();
      await audio.play();
    },
    [allow, onPlayFailed],
  );

  /** 对应 _toggle_play：正在响的这一行按下是暂停，暂停着的这一行按下是继续，别的行是从头播。 */
  const togglePlay = useCallback(
    (path: string) => {
      const audio = audioRef.current;
      if (!audio) return;
      if (playingPathRef.current === path) {
        if (!audio.paused) audio.pause();
        else runAsync(audio.play().catch(onPlayFailed));
        return;
      }
      // 用户手动播放时中止探测，免得探测回头来抢播放器
      pauseProbe();
      probeRef.current.queue = [];
      setPlayingPath(path);
      runAsync(playFrom(path).catch(onPlayFailed));
    },
    [onPlayFailed, pauseProbe, playFrom, setPlayingPath],
  );

  /** 对应 stop_playback：停下并把位置归零，播放器空出来后继续没探完的时长。 */
  const stopPlayback = useCallback(() => {
    const audio = audioRef.current;
    setPlayingPath(null);
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    pauseProbe();
    void probeNext();
  }, [pauseProbe, probeNext, setPlayingPath]);

  /** 停下并清掉音源，对应源项目里 player.stop() 加 setSource(QUrl())。 */
  const releasePlayer = useCallback(() => {
    const audio = audioRef.current;
    setPlayingPath(null);
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
  }, [setPlayingPath]);

  const removeAudio = useCallback(
    (path: string) => {
      const probe = probeRef.current;
      const probingIt = probe.active && probe.queue[0] === path;
      const wasPlaying = playingPathRef.current === path;
      if (wasPlaying) releasePlayer();
      probe.queue = probe.queue.filter((queued) => queued !== path);
      setDurations((previous) => {
        if (previous[path] === undefined) return previous;
        const next = { ...previous };
        delete next[path];
        return next;
      });
      commit(pathsRef.current.filter((item) => item !== path));
      // 被移除的正是探到一半的那个，或者播放器刚空出来：接着探下一个
      if (probingIt || wasPlaying) {
        pauseProbe();
        void probeNext();
      }
    },
    [commit, pauseProbe, probeNext, releasePlayer],
  );

  const clearAudios = useCallback(() => {
    releasePlayer();
    pauseProbe();
    probeRef.current.queue = [];
    setDurations((previous) => (Object.keys(previous).length === 0 ? previous : {}));
    if (pathsRef.current.length > 0) commit([]);
  }, [commit, pauseProbe, releasePlayer]);

  // 对应 add_files。showLimitWarning 为假时超限只截断、不提示，恢复历史参数时用
  const addFilesInternal = useCallback(
    (candidates: readonly string[], showLimitWarning: boolean): number => {
      const max = latest.current.maxFiles;
      // 源项目在这里统一 normpath：对话框和拖拽给出的路径可能是正斜杠，规整后才和已有路径对得上
      const normalized = candidates.filter((path) => path !== "").map(normalizePath);
      const plan = planSlots(pathsRef.current, normalized, max, isSupportedAudio);
      if (plan.full) {
        if (showLimitWarning) notice("warning", tr("common.limit_reached"), tr("audio.msg.limit_reached", { max }));
        return 0;
      }
      if (plan.toAdd.length === 0) return 0;
      commit([...pathsRef.current, ...plan.toAdd]);
      probeRef.current.queue.push(...plan.toAdd);
      // 提前放行，之后点播放不必再等
      for (const path of plan.toAdd) runAsync(allow(path));
      void probeNext();
      if (plan.skipped > 0 && showLimitWarning) {
        notice("warning", tr("common.limit_reached"), tr("audio.msg.limit_skipped", { max, count: plan.skipped }));
      }
      return plan.toAdd.length;
    },
    [allow, commit, probeNext],
  );

  // 对应 open_file_dialog；对话框开着时再点不开第二个
  const openFileDialog = useCallback(async () => {
    const picked = await pickOnce(() =>
      platform.dialog.pickFiles({
        title: tr("audio.dialog.open_files"),
        multiple: true,
        filters: [parseFileFilter(tr("audio.dialog.filter"))],
      }),
    );
    addFilesInternal(picked, true);
  }, [addFilesInternal]);

  useEffect(() => {
    // 拖放由平台层接管，网页收不到浏览器自己的 drop 事件
    const unsubscribe = platform.dragDrop.subscribe((event) => {
      // 光标落在自己身上才高亮、才接收
      const inside = isDragOver(rootRef.current, event);
      if (event.type === "drop") {
        setDragOver(false);
        if (inside) addFilesInternal(event.paths, true);
        return;
      }
      setDragOver(event.type !== "leave" && inside);
    });
    return unsubscribe;
  }, [addFilesInternal]);

  useImperativeHandle(
    ref,
    () => ({
      getPaths: () => [...pathsRef.current],
      addFiles: async (paths, options) => {
        addFilesInternal(paths, options?.showLimitWarning ?? false);
      },
      clearAudios,
      openFileDialog,
    }),
    [addFilesInternal, clearAudios, openFileDialog],
  );

  // 加载出错时退回播放图标；原因由 play() 的拒绝去记，这里不重复
  const onMediaError = () => {
    if (playingPathRef.current !== null) setPlayingPath(null);
  };

  const onLoadedMetadata = (event: SyntheticEvent<HTMLAudioElement>) => {
    // 探测时播放器不属于任何一行，时长由探测自己去记
    const path = playingPathRef.current;
    if (path !== null) recordDuration(path, event.currentTarget.duration);
  };

  const onEnded = () => {
    setPlayingPath(null);
    pauseProbe();
    void probeNext();
  };

  const hint = t("audio.add_hint", { max: maxFiles });

  return (
    <div
      ref={rootRef}
      className={[
        "audio-drop-area",
        paths.length > 0 ? "audio-drop-area--filled" : "",
        dragOver ? "audio-drop-area--dragover" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {paths.length === 0 ? (
        <Button
          appearance="transparent"
          className="audio-drop-area__hint"
          icon={<MusicNote220Regular />}
          aria-label={hint}
          onClick={() => runAsync(openFileDialog())}
        >
          {hint}
        </Button>
      ) : (
        <div className="audio-drop-area__table-wrap">
          <table className="audio-drop-area__table">
            <colgroup>
              <col />
              <col className="audio-drop-area__col-duration" />
              <col className="audio-drop-area__col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{t("audio.column.name")}</th>
                <th scope="col">{t("audio.column.duration")}</th>
                <th scope="col">{t("audio.column.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {paths.map((path) => (
                <AudioRow
                  key={path}
                  path={path}
                  durationMs={durations[path]}
                  current={audible && playingPath === path}
                  onToggle={() => togglePlay(path)}
                  onStop={stopPlayback}
                  onRemove={() => removeAudio(path)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* 所有行共用的播放器，探时长也用它 */}
      <audio
        ref={audioRef}
        className="audio-drop-area__player"
        preload="metadata"
        onPlay={() => setAudible(true)}
        onPause={() => setAudible(false)}
        onEnded={onEnded}
        onLoadedMetadata={onLoadedMetadata}
        onError={onMediaError}
      />
    </div>
  );
}

interface AudioRowProps {
  path: string;
  durationMs: number | undefined;
  /** 这一行正在响：图标换成暂停。 */
  current: boolean;
  onToggle(): void;
  onStop(): void;
  onRemove(): void;
}

function AudioRow({ path, durationMs, current, onToggle, onStop, onRemove }: AudioRowProps) {
  const t = useTr();
  const playLabel = current ? t("audio.tooltip.pause") : t("audio.tooltip.play");
  return (
    <tr>
      <td title={path}>
          <MarqueeText text={platform.paths.basename(path)} />
        </td>
      <td title={t("audio.column.duration")}>{formatDuration(durationMs)}</td>
      <td>
        <div className="audio-drop-area__actions">
          <Tooltip content={playLabel} relationship="label">
            <Button
              appearance="transparent"
              size="small"
              className="audio-drop-area__action"
              icon={current ? <Pause20Regular /> : <Play20Regular />}
              aria-label={playLabel}
              onClick={onToggle}
            />
          </Tooltip>
          <Tooltip content={t("audio.tooltip.stop")} relationship="label">
            <Button
              appearance="transparent"
              size="small"
              className="audio-drop-area__action"
              icon={<Dismiss20Regular />}
              aria-label={t("audio.tooltip.stop")}
              onClick={onStop}
            />
          </Tooltip>
          <Tooltip content={t("audio.tooltip.delete")} relationship="label">
            <Button
              appearance="transparent"
              size="small"
              className="audio-drop-area__action"
              icon={<Delete20Regular />}
              aria-label={t("audio.tooltip.delete")}
              onClick={onRemove}
            />
          </Tooltip>
        </div>
      </td>
    </tr>
  );
}
