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
import type { AudioDropAreaHandle, ImageDropAreaHandle } from "../components/dropAreaTypes";
import ImageDropArea from "../components/ImageDropArea";
import { notice } from "../components/Notice";
import PromptWidget, { type PromptWidgetHandle } from "../components/PromptWidget";
import { SegmentedHeader } from "../components/SegmentedHeader";
import { TaskListView } from "../components/TaskList";
import { DEFAULT_CONFIG } from "../core/config";
import type { HistoryTask } from "../core/history";
import { VIDEO_MODEL_IDS, VIDEO_MODELS, videoDurationBounds, videoModelSpec } from "../core/modelCatalog";
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
  clampDuration,
  initialState,
  parallelTasksOf,
  refAudiosOf,
  refModeOf,
  restoreTask,
  taskParams,
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

/** 素材区的引用：恢复历史参数时要往这四个区里加东西。 */
interface MaterialSlots {
  drop: RefObject<ImageDropAreaHandle | null>;
  firstFrame: RefObject<ImageDropAreaHandle | null>;
  lastFrame: RefObject<ImageDropAreaHandle | null>;
  audio: RefObject<AudioDropAreaHandle | null>;
}

/** 对应 apply_history_task 的后半段：参考图、音频和首尾帧按记录里的顺序加回来。 */
async function restoreMaterials(task: HistoryTask, slots: MaterialSlots): Promise<void> {
  // 对应源项目：先清空，再按记录里的顺序加回来
  slots.drop.current?.clearImages();
  for (const path of refImagesOf(task)) await slots.drop.current?.addImage(path);

  slots.audio.current?.clearAudios();
  const audios = refAudiosOf(task);
  if (audios.length > 0) await slots.audio.current?.addFiles(audios, { showLimitWarning: false });

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

/** 标题加上编辑控件，模型的标题在控件上方。 */
function Field({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="video__field">
      <span className="video__caption">{caption}</span>
      {children}
    </div>
  );
}

/** 参数行里的一格：标题在左，控件占满剩下的宽度，与源项目的 param_row 一致。 */
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

  const spec = videoModelSpec(form.model);
  const [minDuration, maxDuration] = videoDurationBounds(form.model);
  const refMode = refModeOf(form.model, framesPreferred);

  // 恢复请求和生成都要按表单最新的一份来算，所以每次渲染后更新这个引用
  const latest = useRef({ form, seedText });
  useEffect(() => {
    latest.current = { form, seedText };
  });

  // 历史页的「重新生成」：只回填，不提交
  useEffect(() =>
    subscribeRestore((request) => {
      if (request.page !== "video") return;
      const restored = restoreTask(latest.current.form, request.task, cfg);
      setForm(restored.state);
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
        }),
      );
    }), []);

  const generate = async () => {
    const { form: current, seedText: currentSeed } = latest.current;
    const prompt = promptRef.current?.getPrompt() ?? "";
    if (!prompt) {
      notice("warning", t("common.warning"), t("video.enter_prompt_warning"));
      return;
    }
    const params = taskParams(current, currentSeed, cfg);
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
      firstFrame: firstFrameRef.current?.getPaths() ?? [],
      lastFrame: lastFrameRef.current?.getPaths() ?? [],
    };
    const currentSpec = videoModelSpec(params.model);
    const inFramesMode = refModeOf(params.model, cfg.get("video_frames_mode", false)) === REF_MODE_FRAMES;
    // 素材模式互斥：首尾帧模式只带 firstFrame/lastFrame，参考图模式只带 images/audios
    let refImageUrls: string[] = [];
    let refAudios: string[] = [];
    let firstFrame: string | null = null;
    let lastFrame: string | null = null;
    if (inFramesMode) {
      [firstFrame, lastFrame] = await Promise.all([firstPath(paths.firstFrame), firstPath(paths.lastFrame)]);
      if (firstFrame === null && lastFrame === null) {
        notice("warning", t("common.warning"), t("video.frames_empty_warning"));
        return;
      }
    } else {
      // 只带还在磁盘上的本地文件，并按模型的上限截断，与源项目一致
      const [imageExists, audioExists] = await Promise.all([existFlags(paths.refImages), existFlags(paths.refAudios)]);
      refImageUrls = paths.refImages.filter((_path, index) => imageExists[index]).slice(0, currentSpec.maxImages);
      refAudios = paths.refAudios.filter((_path, index) => audioExists[index]).slice(0, currentSpec.maxAudios);
    }
    for (let index = 0; index < parallel; index += 1) {
      videoTasks.create({
        prompt,
        spec: { prompt, ...params, refImageUrls, refAudios, firstFrame, lastFrame },
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

  const onResolutionChange = (resolution: string) => {
    const changed = changeResolution(form, resolution);
    setForm(changed.state);
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
            <Field caption={t("video.model")}>
              <Select
                value={form.model}
                aria-label={t("video.model")}
                onChange={(_event, data) => setForm(changeModel(form, data.value, cfg))}
              >
                {VIDEO_MODEL_IDS.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </Select>
            </Field>

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
              <InlineField caption={t("video.duration")}>
                {/* 换模型时整个重建：输入框里还没提交的文字不会盖住刚恢复的时长，与源项目重设 SpinBox 一致 */}
                <SpinButton
                  key={form.model}
                  value={form.duration}
                  min={minDuration}
                  max={maxDuration}
                  step={1}
                  aria-label={t("video.duration")}
                  onChange={(_event, data) => {
                    // 键入后移开焦点提交的值只带在 displayValue 里，受控的 SpinButton 就是这样回传的；
                    // 不是数字或清空了的按没改处理，沿用上一次的值
                    const typed = data.value ?? (data.displayValue?.trim() ? Number(data.displayValue) : NaN);
                    if (!Number.isFinite(typed)) return;
                    update({ duration: clampDuration(form.model, typed) });
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
                <AudioDropArea ref={audioRef} maxFiles={MAX_AUDIOS} />
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

          <PromptWidget ref={promptRef} className="video__prompt" />
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
