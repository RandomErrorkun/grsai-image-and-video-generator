/**
 * 视频生成页（对应 ui/video_page.py）。
 * 显示哪些控件、各控件的选项全看模型清单里的条目。上次的模型和参数记在配置里，
 * 写回的时刻与源项目一致：点生成。素材有两种互斥的模式：参考图加参考音频，或者首帧加尾帧。
 * 取值和切换的规则在 videoView.ts，这里只负责画。
 */
import { useEffect, useRef, useState, type ComponentProps, type ReactNode, type Ref, type RefObject } from "react";
import { Button, Checkbox, Input, Select, Slider, SpinButton, Tooltip } from "@fluentui/react-components";
import { Add20Regular, ClipboardPaste20Regular, Delete20Regular } from "@fluentui/react-icons";
import AudioDropArea from "../components/AudioDropArea";
import type { AudioDropAreaHandle, ImageDropAreaHandle, VideoDropAreaHandle } from "../components/dropAreaTypes";
import ImageDropArea from "../components/ImageDropArea";
import { ModelAvailabilityButton, ModelDropdown } from "../components/ModelDropdown";
import { notice } from "../components/Notice";
import PromptWidget, { type PromptWidgetHandle } from "../components/PromptWidget";
import { SegmentedHeader } from "../components/SegmentedHeader";
import { TaskListView } from "../components/TaskList";
import VideoDropArea from "../components/VideoDropArea";
import type { VideoReferenceOption } from "../core/api";
import { DEFAULT_CONFIG } from "../core/config";
import type { HistoryTask } from "../core/history";
import { VIDEO_MODEL_IDS, VIDEO_MODELS, videoModelSpec } from "../core/modelCatalog";
import { useConfigValue } from "../hooks/useConfigValue";
import { useTr } from "../hooks/useLanguage";
import { runAsync } from "../platform/async";
import { cfg } from "../state/config";
import { subscribeRestore } from "../state/restore";
import { localFiles } from "../state/services";
import { videoTasks } from "../state/taskLists";
import { refImagesOf } from "./generatorView";
import {
  PARALLEL_MAX,
  PARALLEL_MIN,
  REF_MODE_FRAMES,
  REF_MODE_REFS,
  aspectLabelKey,
  changeModel,
  changeResolution,
  effectiveDurationBounds,
  initialState,
  parallelTasksOf,
  refAudiosOf,
  refModeOf,
  refVideoOptionsOf,
  refVideosOf,
  restoreTask,
  taskParams,
  validateDurationInput,
  validateVideoRefs,
  type VideoState,
} from "./videoView";
import "./VideoPage.css";

/**
 * 参考音频区的上限。源项目建这一区时取的是所有模型里最大的那个，换模型时不跟着改：
 * minimax-h3、agnes-video-2.5 的界面上也写着 5，多出来的在生成时才按模型的上限截掉。照搬。
 */
const MAX_AUDIOS = Math.max(...VIDEO_MODELS.map((model) => model.maxAudios));

/** 每个路径是不是还在磁盘上的本地文件；查不出来按不在处理。 */
function existFlags(paths: readonly string[]): Promise<boolean[]> {
  return Promise.all(paths.map((path) => localFiles.isFile(path).catch(() => false)));
}

/** 单图素材区（首帧、尾帧）的第一个路径，文件不在了就是 null。 */
async function firstPath(paths: readonly string[]): Promise<string | null> {
  const path = paths[0];
  if (path === undefined || !(await localFiles.isFile(path).catch(() => false))) return null;
  return path;
}

/** 素材区的引用：恢复历史参数时要往这五个区里加东西。 */
interface MaterialSlots {
  drop: RefObject<ImageDropAreaHandle | null>;
  firstFrame: RefObject<ImageDropAreaHandle | null>;
  lastFrame: RefObject<ImageDropAreaHandle | null>;
  audio: RefObject<AudioDropAreaHandle | null>;
  video: RefObject<VideoDropAreaHandle | null>;
}

/** 对应 apply_history_task 的后半段：参考图、音频、视频和首尾帧按记录里的顺序加回来。 */
async function restoreMaterials(task: HistoryTask, slots: MaterialSlots): Promise<void> {
  // 对应源项目：先清空，再按记录里的顺序加回来
  slots.drop.current?.clearImages();
  for (const path of refImagesOf(task)) await slots.drop.current?.addImage(path);

  slots.audio.current?.clearAudios();
  const audios = refAudiosOf(task);
  if (audios.length > 0) await slots.audio.current?.addFiles(audios, { showLimitWarning: false });

  slots.video.current?.clearVideos();
  const videos = refVideosOf(task);
  if (videos.length > 0) {
    await slots.video.current?.addVideos(videos, {
      showLimitWarning: false,
      itemOptions: refVideoOptionsOf(task),
    });
  }

  slots.firstFrame.current?.clearImages();
  slots.lastFrame.current?.clearImages();
  // 首尾帧只在文件还在时加回
  for (const [slot, path] of [
    [slots.firstFrame, task.first_frame],
    [slots.lastFrame, task.last_frame],
  ] as const) {
    if (path && (await localFiles.isFile(path).catch(() => false))) await slot.current?.addImage(path);
  }
}

/** 参数行里的一格：标题在左，控件占满剩下的宽度。 */
function InlineField({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="video__inline">
      <span className="video__caption">{caption}</span>
      <div className="video__control">{children}</div>
    </div>
  );
}

/** 素材区标题栏上的小按钮，对应源项目的 TransparentToolButton。 */
function ToolButton({ icon, label, onClick }: { icon: ComponentProps<typeof Button>["icon"]; label: string; onClick(): void }) {
  return (
    <Tooltip content={label} relationship="label">
      <Button appearance="transparent" size="small" icon={icon} aria-label={label} onClick={onClick} />
    </Tooltip>
  );
}

interface FrameSlotProps {
  title: string;
  placeholderKey: string;
  areaRef: Ref<ImageDropAreaHandle>;
  pasteLabel: string;
  clearLabel: string;
  onPaste(): void;
  onClear(): void;
}

/** 首帧或尾帧的槽位：标题行（粘贴、清除按钮）加一个单图素材区，对应 _build_frame_slot。 */
function FrameSlot({ title, placeholderKey, areaRef, pasteLabel, clearLabel, onPaste, onClear }: FrameSlotProps) {
  return (
    <div className="video__frame-slot">
      <div className="video__section-header">
        <span className="video__section-title">{title}</span>
        <div className="video__tools">
          <ToolButton icon={<ClipboardPaste20Regular />} label={pasteLabel} onClick={onPaste} />
          <ToolButton icon={<Delete20Regular />} label={clearLabel} onClick={onClear} />
        </div>
      </div>
      <ImageDropArea ref={areaRef} maxImages={1} placeholderKey={placeholderKey} className="video__frame-drop" />
    </div>
  );
}

export default function VideoPage() {
  const t = useTr();
  const [form, setForm] = useState<VideoState>(() => initialState(cfg));
  const [durationText, setDurationText] = useState(() => String(initialState(cfg).duration));
  const [seedText, setSeedText] = useState("");
  const [autoRetry, setAutoRetry] = useState(
    () => cfg.get("auto_retry_on_failure", DEFAULT_CONFIG.auto_retry_on_failure) === true,
  );
  const [parallel, setParallel] = useState(() =>
    parallelTasksOf(cfg.get("video_parallel_tasks", DEFAULT_CONFIG.video_parallel_tasks), DEFAULT_CONFIG.video_parallel_tasks),
  );
  // 素材模式的偏好记在配置里；对不支持首尾帧的模型只是临时回退，偏好本身不动
  const framesPreferred = useConfigValue("video_frames_mode", DEFAULT_CONFIG.video_frames_mode) === true;
  const promptRef = useRef<PromptWidgetHandle>(null);
  const dropRef = useRef<ImageDropAreaHandle>(null);
  // 首帧槽位排在尾帧前面挂载：Ctrl+V 落进还有空位的那个素材区，顺序就是源项目的 _paste_target
  const firstFrameRef = useRef<ImageDropAreaHandle>(null);
  const lastFrameRef = useRef<ImageDropAreaHandle>(null);
  const audioRef = useRef<AudioDropAreaHandle>(null);
  const videoRef = useRef<VideoDropAreaHandle>(null);

  const spec = videoModelSpec(form.model);
  const [minDuration, maxDuration] = effectiveDurationBounds(form.model, form.resolution);
  const refMode = refModeOf(form.model, framesPreferred);

  // 恢复请求和生成都要按表单最新的一份来算，所以每次渲染后更新这个引用
  const latest = useRef({ form, seedText, durationText });
  useEffect(() => {
    latest.current = { form, seedText, durationText };
  });

  // 历史页的「重新生成」：只回填，不提交
  useEffect(() =>
    subscribeRestore((request) => {
      if (request.page !== "video") return;
      const restored = restoreTask(latest.current.form, request.task, cfg);
      setForm(restored.state);
      setDurationText(String(restored.state.duration));
      setSeedText(restored.seedText);
      promptRef.current?.setPrompt(request.task.prompt);
      if (restored.cappedAt !== null) {
        notice("info", t("common.note"), t("video.duration_capped", { max: restored.cappedAt }));
      }
      // 记录里带首帧或尾帧：切到首尾帧模式，和点选项卡一样记住这个偏好
      if (restored.framesMode) cfg.set("video_frames_mode", true);
      runAsync(
        restoreMaterials(request.task, {
          drop: dropRef,
          firstFrame: firstFrameRef,
          lastFrame: lastFrameRef,
          audio: audioRef,
          video: videoRef,
        }),
      );
    }), []);

  const generate = async () => {
    const { form: current, seedText: currentSeed, durationText: currentDurationText } = latest.current;
    const prompt = promptRef.current?.getPrompt() ?? "";
    if (!prompt) {
      notice("warning", t("common.warning"), t("video.enter_prompt_warning"));
      return;
    }
    const durationCheck = validateDurationInput(currentDurationText, current.model, current.resolution);
    if (!durationCheck.ok) {
      notice("warning", t("common.warning"), t("video.duration_invalid", { min: durationCheck.min, max: durationCheck.max }));
      return;
    }
    const validatedForm = current.duration === durationCheck.value ? current : { ...current, duration: durationCheck.value };
    const params = taskParams(validatedForm, currentSeed, cfg);
    if (params === "seed_invalid") {
      notice("warning", t("common.warning"), t("video.seed_invalid"));
      return;
    }
    cfg.set("auto_retry_on_failure", autoRetry);
    cfg.set("video_parallel_tasks", parallel);
    // 参数和开关在这一刻定下来：查素材要等文件系统，回来之前表单可能已经变了
    const paths = {
      refImages: dropRef.current?.getPaths() ?? [],
      refAudios: audioRef.current?.getPaths() ?? [],
      refVideos: videoRef.current?.getVideos() ?? [],
      firstFrame: firstFrameRef.current?.getPaths() ?? [],
      lastFrame: lastFrameRef.current?.getPaths() ?? [],
    };
    const currentSpec = videoModelSpec(params.model);
    const inFramesMode = refModeOf(params.model, cfg.get("video_frames_mode", false)) === REF_MODE_FRAMES;
    // 素材模式互斥：首尾帧模式只带 firstFrame/lastFrame，参考图模式只带 images/audios/videos
    let refImageUrls: string[] = [];
    let refAudios: string[] = [];
    let refVideos: string[] | undefined;
    let videoOptions: VideoReferenceOption[] | undefined;
    let firstFrame: string | null = null;
    let lastFrame: string | null = null;
    if (inFramesMode) {
      [firstFrame, lastFrame] = await Promise.all([firstPath(paths.firstFrame), firstPath(paths.lastFrame)]);
      if (currentSpec.requiresBothFrames && (firstFrame === null || lastFrame === null)) {
        notice("warning", t("common.warning"), t("video.frames_both_required"));
        return;
      }
      if (firstFrame === null && lastFrame === null) {
        notice("warning", t("common.warning"), t("video.frames_empty_warning"));
        return;
      }
    } else {
      // 只带还在磁盘上的本地文件，并按模型的上限截断，与源项目一致
      const [imageExists, audioExists, videoExists] = await Promise.all([
        existFlags(paths.refImages),
        existFlags(paths.refAudios),
        existFlags(paths.refVideos.map((v) => v.path)),
      ]);
      refImageUrls = paths.refImages.filter((_path, index) => imageExists[index]).slice(0, currentSpec.maxImages);
      refAudios = paths.refAudios.filter((_path, index) => audioExists[index]).slice(0, currentSpec.maxAudios);
      if (currentSpec.maxVideos > 0) {
        const existingVideos = paths.refVideos
          .filter((_video, index) => videoExists[index])
          .slice(0, currentSpec.maxVideos);
        const check = validateVideoRefs(existingVideos, currentSpec);
        if (!check.ok) {
          if (check.kind === "total_too_long") {
            notice("warning", t("common.warning"), t("video.msg.video_total_too_long", { total: check.total, max: check.max }));
          } else {
            notice("warning", t("common.warning"), t("video.msg.video_start_invalid", { max: check.max }));
          }
          return;
        }
        if (existingVideos.length > 0) {
          refVideos = existingVideos.map((item) => item.path);
          videoOptions = existingVideos.map((item) => ({
            startSeconds: item.startSeconds,
            requireAudio: item.requireAudio,
          }));
        }
      }
    }
    for (let index = 0; index < parallel; index += 1) {
      videoTasks.create({
        prompt,
        spec: { prompt, ...params, refImageUrls, refAudios, refVideos, videoOptions, firstFrame, lastFrame },
        mediaType: "video",
        autoRetry,
      });
    }
  };

  const update = (patch: Partial<VideoState>) => setForm({ ...form, ...patch });

  const aspectLabel = (aspect: string) => {
    const key = aspectLabelKey(aspect);
    return key === null ? aspect : t(key);
  };

  const onModelChange = (model: string) => {
    const next = changeModel(form, model, cfg);
    setForm(next);
    setDurationText(String(next.duration));
  };

  const onResolutionChange = (resolution: string) => {
    const changed = changeResolution(form, resolution);
    setForm(changed.state);
    setDurationText(String(changed.state.duration));
    if (changed.cappedAt !== null) notice("info", t("common.note"), t("video.duration_capped", { max: changed.cappedAt }));
  };

  // 点选项卡才记住偏好；选中的那一项再点一下不动作，与源项目的 currentItemChanged 一致
  const onRefModeChange = (key: string) => {
    const next = key === REF_MODE_FRAMES;
    if (next !== (refMode === REF_MODE_FRAMES)) cfg.set("video_frames_mode", next);
  };

  const pasteLabel = t("drop.tooltip.paste");
  const clearLabel = t("drop.tooltip.clear");

  return (
    <div className="page video">
      <div className="video__main">
        <div className="video__settings">
          <SegmentedHeader items={[{ key: "video", label: "nav.video" }]} />

          <div className="video__card">
            <div className="video__row">
              <InlineField caption={t("video.model")}>
                <ModelDropdown
                  value={form.model}
                  models={VIDEO_MODEL_IDS}
                  ariaLabel={t("video.model")}
                  onChange={onModelChange}
                />
              </InlineField>
              <ModelAvailabilityButton />
            </div>

            <div className="video__row">
              <InlineField caption={t("video.aspect_ratio")}>
                <Select
                  value={form.aspect}
                  aria-label={t("video.aspect_ratio")}
                  onChange={(_event, data) => update({ aspect: data.value })}
                >
                  {spec.aspects.map((aspect) => (
                    <option key={aspect} value={aspect}>
                      {aspectLabel(aspect)}
                    </option>
                  ))}
                </Select>
              </InlineField>
              <InlineField caption={t("video.resolution")}>
                <Select
                  value={form.resolution}
                  aria-label={t("video.resolution")}
                  onChange={(_event, data) => onResolutionChange(data.value)}
                >
                  {spec.resolutions.map((resolution) => (
                    <option key={resolution} value={resolution}>
                      {resolution}
                    </option>
                  ))}
                </Select>
              </InlineField>
            </div>

            <div className="video__row">
              <InlineField caption={`${t("video.duration")} (${minDuration}~${maxDuration})`}>
                {/* 换模型或分辨率上限变动时同步范围，支持上下微调和手动输入校验 */}
                <SpinButton
                  key={`${form.model}:${maxDuration}`}
                  value={form.duration}
                  displayValue={durationText}
                  min={minDuration}
                  max={maxDuration}
                  step={1}
                  aria-label={t("video.duration")}
                  onInput={(event) => setDurationText((event.target as HTMLInputElement).value)}
                  onChange={(_event, data) => {
                    if (data.value !== undefined && data.value !== null) {
                      const bounded = Math.min(maxDuration, Math.max(minDuration, Math.trunc(data.value)));
                      update({ duration: bounded });
                      setDurationText(String(bounded));
                      return;
                    }
                    const raw = data.displayValue ?? "";
                    setDurationText(raw);
                    const check = validateDurationInput(raw, form.model, form.resolution);
                    if (check.ok) {
                      update({ duration: check.value });
                      setDurationText(String(check.value));
                    } else {
                      notice("warning", t("common.warning"), t("video.duration_invalid", { min: check.min, max: check.max }));
                    }
                  }}
                />
              </InlineField>
              <InlineField caption={t("video.seed")}>
                <Input
                  value={seedText}
                  placeholder={t("video.seed_placeholder")}
                  aria-label={t("video.seed")}
                  onChange={(_event, data) => setSeedText(data.value)}
                />
              </InlineField>
            </div>

            <div className="video__row video__row--retry">
              <Checkbox
                className="video__retry"
                label={t("generator.auto_retry")}
                checked={autoRetry}
                onChange={(_event, data) => setAutoRetry(data.checked === true)}
              />
              <div className="video__parallel">
                <span>{t("generator.parallel_tasks")}</span>
                <Slider
                  className="video__slider"
                  min={PARALLEL_MIN}
                  max={PARALLEL_MAX}
                  step={1}
                  value={parallel}
                  aria-label={t("generator.parallel_tasks")}
                  onChange={(_event, data) => setParallel(data.value)}
                />
                <span className="video__parallel-value">{parallel}</span>
              </div>
            </div>

            {spec.hintKey ? <p className="video__hint">{t(spec.hintKey)}</p> : null}
          </div>
        </div>

        <div className="video__middle">
          <div className="video__ref-column">
            {/* 模式切换只有支持首尾帧的模型看得见 */}
            {spec.supportsFrames ? (
              <SegmentedHeader
                items={[
                  { key: REF_MODE_REFS, label: "video.ref_mode.refs" },
                  { key: REF_MODE_FRAMES, label: "video.ref_mode.frames" },
                ]}
                value={refMode}
                onChange={onRefModeChange}
              />
            ) : null}

            {/* 两块素材面板都常驻，换模式只是显示与隐藏：切回去时已经加了的素材还在 */}
            <div className={refMode === REF_MODE_FRAMES ? "video__stack video__stack--frames" : "video__stack"}>
              <div className="video__refs">
                <div className="video__section-header">
                  <span className="video__section-title">{t("video.reference_images")}</span>
                  <div className="video__tools">
                    <ToolButton
                      icon={<ClipboardPaste20Regular />}
                      label={pasteLabel}
                      onClick={() => runAsync(dropRef.current?.pasteFromClipboard() ?? Promise.resolve())}
                    />
                    <ToolButton icon={<Delete20Regular />} label={clearLabel} onClick={() => dropRef.current?.clearImages()} />
                  </div>
                </div>
                <ImageDropArea ref={dropRef} maxImages={spec.maxImages} className="video__drop" />

                <div className="video__section-header">
                  <span className="video__section-title">{t("video.reference_audios")}</span>
                  <div className="video__tools">
                    <ToolButton
                      icon={<Add20Regular />}
                      label={t("audio.tooltip.add")}
                      onClick={() => runAsync(audioRef.current?.openFileDialog() ?? Promise.resolve())}
                    />
                    <ToolButton icon={<Delete20Regular />} label={clearLabel} onClick={() => audioRef.current?.clearAudios()} />
                  </div>
                </div>
                <AudioDropArea ref={audioRef} maxFiles={MAX_AUDIOS} className="video__audio-drop" />
              </div>

              <div className="video__frames">
                <FrameSlot
                  title={t("video.first_frame")}
                  placeholderKey="video.first_frame_placeholder"
                  areaRef={firstFrameRef}
                  pasteLabel={pasteLabel}
                  clearLabel={clearLabel}
                  onPaste={() => runAsync(firstFrameRef.current?.pasteFromClipboard() ?? Promise.resolve())}
                  onClear={() => firstFrameRef.current?.clearImages()}
                />
                <FrameSlot
                  title={t("video.last_frame")}
                  placeholderKey="video.last_frame_placeholder"
                  areaRef={lastFrameRef}
                  pasteLabel={pasteLabel}
                  clearLabel={clearLabel}
                  onPaste={() => runAsync(lastFrameRef.current?.pasteFromClipboard() ?? Promise.resolve())}
                  onClear={() => lastFrameRef.current?.clearImages()}
                />
              </div>
            </div>
          </div>

          <div className="video__prompt-column">
            <PromptWidget ref={promptRef} className="video__prompt" />
            <div
              className={
                spec.maxVideos > 0 && refMode === REF_MODE_REFS
                  ? "video__video-refs"
                  : "video__video-refs video__video-refs--hidden"
              }
            >
              <div className="video__section-header">
                <span className="video__section-title">{t("video.reference_videos")}</span>
                <div className="video__tools">
                  <ToolButton
                    icon={<Add20Regular />}
                    label={t("video.dialog.open_videos")}
                    onClick={() => runAsync(videoRef.current?.openFileDialog() ?? Promise.resolve())}
                  />
                  <ToolButton icon={<Delete20Regular />} label={clearLabel} onClick={() => videoRef.current?.clearVideos()} />
                </div>
              </div>
              <VideoDropArea
                ref={videoRef}
                maxVideos={spec.maxVideos > 0 ? spec.maxVideos : 5}
                fields={spec.videoFields}
                className="video__video-drop"
              />
            </div>
          </div>
        </div>

        <Button appearance="primary" size="large" className="video__generate" onClick={() => runAsync(generate())}>
          {t("video.generate")}
        </Button>
      </div>

      <div className="video__side">
        <SegmentedHeader items={[{ key: "task_list", label: "video.task_list" }]} />
        <TaskListView
          list={videoTasks}
          onRegenerate={(card) => void videoTasks.regenerate(card.index, autoRetry)}
          className="video__tasks"
        />
      </div>
    </div>
  );
}
