/**
 * 漫画生成页（对应 ui/comic_page.py）。
 * 三栏布局（左 3 : 中 4 : 右 2）：项目与参数/参考图、可拖拽重排的分页脚本卡片、漫画任务列表。
 * 剧情规划默认走 Grsai 中转的 CHAT_MODELS；若设置页填了自定义 OpenAI 兼容对话接口，则走自定义接口。
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Button, Checkbox, Input, Select, Textarea, Tooltip } from "@fluentui/react-components";
import {
  ArrowDown20Regular,
  ArrowSync20Regular,
  ArrowUp20Regular,
  ClipboardPaste20Regular,
  Delete20Regular,
  ReOrderDotsVertical20Regular,
} from "@fluentui/react-icons";
import type { ImageDropAreaHandle } from "../components/dropAreaTypes";
import ImageDropArea from "../components/ImageDropArea";
import { ModelDropdown } from "../components/ModelDropdown";
import { notice } from "../components/Notice";
import { SegmentedHeader } from "../components/SegmentedHeader";
import { TaskListView } from "../components/TaskList";
import { planComic, type ComicPage as ComicPageData, type CustomChatConfig } from "../core/comicPlanner";
import { DEFAULT_CONFIG } from "../core/config";
import { CHAT_MODELS, COMIC_IMAGE_MODELS } from "../core/modelCatalog";
import { useConfigValue } from "../hooks/useConfigValue";
import { useTr } from "../hooks/useLanguage";
import { normalizeLanguage } from "../i18n";
import { platform } from "../platform";
import { runAsync } from "../platform/async";
import { cfg } from "../state/config";
import { apiSettings, comicProjects, localFiles } from "../state/services";
import { comicTasks } from "../state/taskLists";
import {
  COMIC_ASPECT_RATIOS,
  COMIC_PAGE_COUNTS,
  buildComicFinalPrompt,
  buildComicTaskSpec,
  comicSizeOptions,
  formatReferenceTargets,
  isCompletionComicModel,
  normalizeComicImageModel,
  parseDialogueLines,
  parseReferenceTargets,
  reorderComicPages,
} from "./comicView";
import "./ComicPage.css";

interface EditablePage extends ComicPageData {
  /** React 列表 key，拖拽重排时不丢失焦点。 */
  _uid: string;
  /** 参考图序号输入框的原始文本。 */
  _refsText: string;
  /** 对白输入框的原始文本。 */
  _dialogueText: string;
}

let pageUidCounter = 0;

function toEditable(page: Partial<ComicPageData>, index: number): EditablePage {
  pageUidCounter += 1;
  const dialogue = Array.isArray(page.dialogue) ? page.dialogue.map(String) : [];
  const refs = Array.isArray(page.reference_targets)
    ? page.reference_targets.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  return {
    _uid: `page-${pageUidCounter}`,
    page_number: typeof page.page_number === "number" ? page.page_number : index + 1,
    title: typeof page.title === "string" ? page.title : "",
    story_beat: typeof page.story_beat === "string" ? page.story_beat : "",
    narration: typeof page.narration === "string" ? page.narration : "",
    dialogue,
    scene_description: typeof page.scene_description === "string" ? page.scene_description : "",
    camera_direction: typeof page.camera_direction === "string" ? page.camera_direction : "",
    panel_layout: typeof page.panel_layout === "string" ? page.panel_layout : "",
    image_prompt: typeof page.image_prompt === "string" ? page.image_prompt : "",
    reference_targets: refs,
    _refsText: formatReferenceTargets(refs),
    _dialogueText: dialogue.join("\n"),
  };
}

function toPlainPage(page: EditablePage, index: number): ComicPageData {
  return {
    page_number: index + 1,
    title: page.title.trim(),
    story_beat: page.story_beat.trim(),
    narration: page.narration,
    dialogue: parseDialogueLines(page._dialogueText),
    scene_description: page.scene_description,
    camera_direction: page.camera_direction,
    panel_layout: page.panel_layout,
    image_prompt: page.image_prompt.trim(),
    reference_targets: parseReferenceTargets(page._refsText),
  };
}

function customChatFromConfig(): CustomChatConfig | null {
  const baseUrl = String(cfg.get("comic_custom_chat_base_url", "") ?? "").trim();
  if (!baseUrl) return null;
  return {
    baseUrl,
    endpoint: String(cfg.get("comic_custom_chat_endpoint", "") ?? ""),
    apiKey: String(cfg.get("comic_custom_chat_api_key", "") ?? ""),
    model: String(cfg.get("comic_custom_chat_model", "") ?? ""),
    extraBody: String(cfg.get("comic_custom_chat_body", "") ?? ""),
  };
}

export default function ComicPage() {
  const t = useTr();
  const customBaseUrl = String(useConfigValue("comic_custom_chat_base_url", "") ?? "").trim();
  const customModel = String(useConfigValue("comic_custom_chat_model", "") ?? "").trim();

  const [projectName, setProjectName] = useState(() => String(cfg.get("comic_last_project", "") ?? ""));
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState("");

  const [storyModel, setStoryModel] = useState<string>(() => {
    const saved = String(cfg.get("comic_story_model", CHAT_MODELS[0]) ?? CHAT_MODELS[0]);
    return (CHAT_MODELS as readonly string[]).includes(saved) ? saved : CHAT_MODELS[0];
  });
  const [imageModel, setImageModel] = useState(() =>
    normalizeComicImageModel(String(cfg.get("comic_image_model", COMIC_IMAGE_MODELS[0]) ?? COMIC_IMAGE_MODELS[0])),
  );
  const [pageCount, setPageCount] = useState(() => {
    const n = Number(cfg.get("comic_page_count", DEFAULT_CONFIG.comic_page_count));
    return COMIC_PAGE_COUNTS.includes(n as (typeof COMIC_PAGE_COUNTS)[number]) ? n : 6;
  });
  const [aspectRatio, setAspectRatio] = useState(() => {
    const r = String(cfg.get("comic_aspect_ratio", DEFAULT_CONFIG.comic_aspect_ratio) ?? "3:4");
    return (COMIC_ASPECT_RATIOS as readonly string[]).includes(r) ? r : "3:4";
  });
  const [imageSize, setImageSize] = useState(() => {
    const initialModel = normalizeComicImageModel(
      String(cfg.get("comic_image_model", COMIC_IMAGE_MODELS[0]) ?? COMIC_IMAGE_MODELS[0]),
    );
    const options = comicSizeOptions(initialModel);
    const key = isCompletionComicModel(initialModel) ? "gpt_image_size" : "comic_image_size";
    const saved = String(cfg.get(key, options[0] ?? "1K") ?? "");
    return options.includes(saved) ? saved : (options[0] ?? "1K");
  });
  const [autoRetry, setAutoRetry] = useState(
    () => cfg.get("auto_retry_on_failure", DEFAULT_CONFIG.auto_retry_on_failure) === true,
  );

  const [storyRequirement, setStoryRequirement] = useState("");
  const [styleNotes, setStyleNotes] = useState("");
  const [pages, setPages] = useState<EditablePage[]>([]);
  const [planStatus, setPlanStatus] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);

  const planMetaRef = useRef({ title: "", styleNotes: "" });
  const generatedOutputsRef = useRef<Record<string, string[]>>({});
  const dropRef = useRef<ImageDropAreaHandle>(null);
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const isCompletion = isCompletionComicModel(imageModel);
  const sizeOptions = comicSizeOptions(imageModel);
  const hasSizeOptions = sizeOptions.length > 0;

  const refreshProjectList = useCallback(async () => {
    try {
      const list = await comicProjects().listProjects();
      setProjects(list);
      const last = String(cfg.get("comic_last_project", "") ?? "");
      if (last && list.includes(last)) setSelectedProject(last);
      else if (list.length > 0) setSelectedProject((prev) => (list.includes(prev) ? prev : list[0]));
      else setSelectedProject("");
    } catch (error) {
      console.error(error);
    }
  }, []);

  useEffect(() => {
    void refreshProjectList();
  }, [refreshProjectList]);

  const onImageModelChange = (nextRaw: string) => {
    const next = normalizeComicImageModel(nextRaw);
    setImageModel(next);
    cfg.set("comic_image_model", next);
    const options = comicSizeOptions(next);
    if (options.length > 0) {
      const isGpt = isCompletionComicModel(next);
      const saved = String(cfg.get(isGpt ? "gpt_image_size" : "comic_image_size", isGpt ? "auto" : "1K") ?? "");
      setImageSize(options.includes(saved) ? saved : options[0]);
    }
  };

  const saveCurrentSettings = () => {
    cfg.set("comic_story_model", storyModel);
    cfg.set("comic_image_model", imageModel);
    cfg.set("comic_page_count", pageCount);
    cfg.set("comic_aspect_ratio", aspectRatio);
    cfg.set("comic_last_project", projectName.trim());
    if (hasSizeOptions) {
      cfg.set(isCompletion ? "gpt_image_size" : "comic_image_size", imageSize);
    }
  };

  const saveProjectState = async (showFeedback: boolean, overridePages?: EditablePage[]) => {
    const trimmedName = projectName.trim();
    if (!trimmedName) {
      if (showFeedback) notice("warning", t("common.warning"), t("comic.project_name_required"));
      return null;
    }
    saveCurrentSettings();
    const listToSave = overridePages ?? pages;
    const saved = await comicProjects().saveProject(trimmedName, {
      story_requirement: storyRequirement.trim(),
      style_notes: styleNotes.trim(),
      plan_title: planMetaRef.current.title,
      plan_style_notes: planMetaRef.current.styleNotes,
      settings: {
        story_model: storyModel,
        image_model: imageModel,
        page_count: pageCount,
        aspect_ratio: aspectRatio,
        image_size: hasSizeOptions ? imageSize : "1K",
        auto_retry: autoRetry,
      },
      pages: listToSave.map((page, index) => toPlainPage(page, index)),
      reference_images: dropRef.current?.getPaths() ?? [],
      generated_outputs: generatedOutputsRef.current,
    });
    setProjectName(saved.project_name);
    cfg.set("comic_last_project", saved.project_name);
    await refreshProjectList();
    setSelectedProject(saved.project_name);
    if (showFeedback) {
      notice("success", t("common.success"), t("comic.project_saved", { name: saved.project_name }));
    }
    return saved;
  };

  const loadSelectedProject = async () => {
    const name = selectedProject.trim();
    if (!name) {
      notice("warning", t("common.warning"), t("comic.project_select_required"));
      return;
    }
    try {
      const payload = await comicProjects().loadProject(name);
      const settings = payload.settings ?? {};
      setProjectName(payload.project_name || name);
      setStoryRequirement(payload.story_requirement || "");
      setStyleNotes(payload.style_notes || "");

      const loadedStory = String(settings.story_model ?? cfg.get("comic_story_model", CHAT_MODELS[0]));
      if ((CHAT_MODELS as readonly string[]).includes(loadedStory)) setStoryModel(loadedStory);

      const loadedImageModel = normalizeComicImageModel(
        String(settings.image_model ?? cfg.get("comic_image_model", COMIC_IMAGE_MODELS[0])),
      );
      setImageModel(loadedImageModel);

      const loadedCount = Number(settings.page_count ?? cfg.get("comic_page_count", 6));
      if (COMIC_PAGE_COUNTS.includes(loadedCount as (typeof COMIC_PAGE_COUNTS)[number])) setPageCount(loadedCount);

      const loadedRatio = String(settings.aspect_ratio ?? cfg.get("comic_aspect_ratio", "3:4"));
      if ((COMIC_ASPECT_RATIOS as readonly string[]).includes(loadedRatio)) setAspectRatio(loadedRatio);

      setAutoRetry(Boolean(settings.auto_retry ?? cfg.get("auto_retry_on_failure", false)));

      const opts = comicSizeOptions(loadedImageModel);
      const loadedSize = String(settings.image_size ?? "");
      if (opts.length > 0) setImageSize(opts.includes(loadedSize) ? loadedSize : opts[0]);

      dropRef.current?.clearImages();
      for (const refPath of payload.resolved_reference_images ?? []) {
        await dropRef.current?.addImage(refPath);
      }

      planMetaRef.current = {
        title: payload.plan_title || "",
        styleNotes: payload.plan_style_notes || "",
      };
      generatedOutputsRef.current =
        payload.generated_outputs && typeof payload.generated_outputs === "object"
          ? (payload.generated_outputs as Record<string, string[]>)
          : {};
      const loadedPages = Array.isArray(payload.pages)
        ? payload.pages.map((p, i) => toEditable(p as Partial<ComicPageData>, i))
        : [];
      setPages(loadedPages);
      setPlanStatus(t("comic.project_loaded", { name }));
      cfg.set("comic_last_project", name);
      notice("success", t("common.success"), t("comic.project_loaded", { name }));
    } catch (error) {
      notice("warning", t("common.warning"), error instanceof Error ? error.message : String(error));
    }
  };

  const ensureProjectName = (): boolean => {
    if (projectName.trim()) return true;
    notice("warning", t("common.warning"), t("comic.project_name_required"));
    return false;
  };

  const onPlanStory = async () => {
    if (!ensureProjectName()) return;
    if (!storyRequirement.trim()) {
      notice("warning", t("common.warning"), t("comic.enter_story_warning"));
      return;
    }
    generatedOutputsRef.current = {};
    await saveProjectState(false);
    setPlanning(true);
    setPlanStatus(t("comic.planning"));
    try {
      const result = await planComic(
        {
          settings: apiSettings(),
          files: localFiles,
          language: normalizeLanguage(cfg.get("language", "en")),
          sendChat: (request) => platform.http.request(request),
          customChat: customChatFromConfig(),
        },
        {
          storyModel,
          storyRequirement: storyRequirement.trim(),
          styleNotes: styleNotes.trim(),
          pageCount,
          referenceImages: dropRef.current?.getPaths() ?? [],
        },
      );
      if (!result.ok) {
        setPlanStatus(t("comic.plan_failed"));
        notice("warning", t("common.warning"), result.message || t("comic.plan_failed"));
        return;
      }
      planMetaRef.current = {
        title: result.plan.title.trim(),
        styleNotes: result.plan.style_notes.trim(),
      };
      const nextPages = result.plan.pages.map((page, index) => toEditable(page, index));
      setPages(nextPages);
      await saveProjectState(false, nextPages);
      setPlanStatus(t("comic.plan_ready", { count: nextPages.length }));
      notice("success", t("common.success"), t("comic.plan_success", { count: nextPages.length }));
    } finally {
      setPlanning(false);
    }
  };

  const launchPageTask = async (page: ComicPageData, outputDir: string) => {
    const rawRefs = dropRef.current?.getPaths() ?? [];
    const exists = await Promise.all(rawRefs.map((p) => localFiles.isFile(p).catch(() => false)));
    const validRefs = rawRefs.filter((_p, i) => exists[i]);
    const specParams = buildComicTaskSpec({
      imageModel,
      aspectRatio,
      imageSize,
      hasSizeOptions,
      pageNumber: page.page_number,
      refImageUrls: validRefs,
      outputDir,
    });
    const prompt = buildComicFinalPrompt(page, {
      planTitle: planMetaRef.current.title,
      planStyleNotes: planMetaRef.current.styleNotes,
      hasReferenceImages: rawRefs.length > 0,
    });
    comicTasks.create({
      prompt,
      spec: { prompt, ...specParams },
      mediaType: "image",
      autoRetry,
      hooks: {
        onSucceeded: (card) => {
          if (!card.resultPath) return;
          const key = String(page.page_number);
          const list = generatedOutputsRef.current[key] ?? [];
          list.push(card.resultPath);
          generatedOutputsRef.current[key] = list;
          void saveProjectState(false);
        },
      },
    });
  };

  const onGenerateAll = async () => {
    if (!ensureProjectName()) return;
    if (pages.length === 0) {
      notice("warning", t("common.warning"), t("comic.no_pages_to_generate"));
      return;
    }
    const saved = await saveProjectState(false);
    const outputDir = saved?.pages_dir ?? "";
    for (let index = 0; index < pages.length; index += 1) {
      await launchPageTask(toPlainPage(pages[index], index), outputDir);
    }
  };

  const onGenerateSingle = async (index: number) => {
    if (!ensureProjectName()) return;
    const saved = await saveProjectState(false);
    const outputDir = saved?.pages_dir ?? "";
    const page = pages[index];
    if (page) await launchPageTask(toPlainPage(page, index), outputDir);
  };

  const updatePage = (uid: string, patch: Partial<EditablePage>) => {
    setPages((current) => current.map((page) => (page._uid === uid ? { ...page, ...patch } : page)));
  };

  const movePage = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || toIndex < 0 || toIndex >= pages.length) return;
    const reordered = reorderComicPages(pages, fromIndex, toIndex) as EditablePage[];
    setPages(reordered);
    if (projectName.trim()) void saveProjectState(false, reordered);
  };

  const onDragStart = (index: number) => {
    dragIndexRef.current = index;
  };

  const onDragOver = (event: DragEvent, index: number) => {
    event.preventDefault();
    if (dragOverIndex !== index) setDragOverIndex(index);
  };

  const onDrop = (event: DragEvent, index: number) => {
    event.preventDefault();
    const from = dragIndexRef.current;
    dragIndexRef.current = null;
    setDragOverIndex(null);
    if (from !== null && from !== index) movePage(from, index);
  };

  const storyModelOptions: readonly string[] =
    customBaseUrl && customModel && !(CHAT_MODELS as readonly string[]).includes(customModel)
      ? [customModel, ...CHAT_MODELS]
      : CHAT_MODELS;
  const activeStoryModel = customBaseUrl && customModel ? customModel : storyModel;

  return (
    <div className="page comic">
      <div className="comic__left">
        <div className="comic__card">
          <span className="comic__card-title">{t("comic.project_title")}</span>
          <div className="comic__row">
            <Input
              className="comic__grow"
              placeholder={t("comic.project_name_placeholder")}
              value={projectName}
              onChange={(_e, data) => setProjectName(data.value)}
            />
            <Button appearance="primary" onClick={() => runAsync(saveProjectState(true))}>
              {t("comic.save_project")}
            </Button>
          </div>
          <div className="comic__row">
            <Select
              className="comic__grow"
              value={selectedProject}
              aria-label={t("comic.project_title")}
              onChange={(_e, data) => setSelectedProject(data.value)}
            >
              {projects.length === 0 ? <option value="">--</option> : null}
              {projects.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
            <Button appearance="primary" onClick={() => runAsync(loadSelectedProject())}>
              {t("comic.load_project")}
            </Button>
            <Tooltip content={t("history.refresh")} relationship="label">
              <Button
                appearance="transparent"
                icon={<ArrowSync20Regular />}
                aria-label={t("history.refresh")}
                onClick={() => runAsync(refreshProjectList())}
              />
            </Tooltip>
          </div>
        </div>

        <div className="comic__card">
          <div className="comic__row">
            <div className="comic__field comic__grow">
              <span className="comic__caption">{t("comic.story_model")}</span>
              <ModelDropdown
                value={activeStoryModel}
                models={storyModelOptions}
                ariaLabel={t("comic.story_model")}
                disabled={Boolean(customBaseUrl && customModel)}
                showAvailability={!customBaseUrl}
                onChange={setStoryModel}
              />
            </div>
            <div className="comic__field comic__grow">
              <span className="comic__caption">{t("comic.image_model")}</span>
              <ModelDropdown
                value={imageModel}
                models={COMIC_IMAGE_MODELS}
                ariaLabel={t("comic.image_model")}
                onChange={onImageModelChange}
              />
            </div>
          </div>

          <div className="comic__row">
            <div className="comic__field comic__grow">
              <span className="comic__caption">{t("comic.page_count")}</span>
              <Select
                value={String(pageCount)}
                aria-label={t("comic.page_count")}
                onChange={(_e, data) => setPageCount(Number(data.value))}
              >
                {COMIC_PAGE_COUNTS.map((n) => (
                  <option key={n} value={String(n)}>
                    {n}
                  </option>
                ))}
              </Select>
            </div>

            {!isCompletion ? (
              <div className="comic__field comic__grow">
                <span className="comic__caption">{t("comic.aspect_ratio")}</span>
                <Select
                  value={aspectRatio}
                  aria-label={t("comic.aspect_ratio")}
                  onChange={(_e, data) => setAspectRatio(data.value)}
                >
                  {COMIC_ASPECT_RATIOS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}

            {hasSizeOptions ? (
              <div className="comic__field comic__grow">
                <span className="comic__caption">{t("comic.image_size")}</span>
                <Select
                  value={imageSize}
                  aria-label={t("comic.image_size")}
                  onChange={(_e, data) => setImageSize(data.value)}
                >
                  {sizeOptions.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
          </div>

          <Checkbox
            label={t("comic.auto_retry")}
            checked={autoRetry}
            onChange={(_e, data) => setAutoRetry(data.checked === true)}
          />
        </div>

        <div className="comic__card">
          <span className="comic__card-title">{t("comic.story_requirement")}</span>
          <Textarea
            className="comic__textarea"
            rows={5}
            placeholder={t("comic.story_requirement_placeholder")}
            value={storyRequirement}
            onChange={(_e, data) => setStoryRequirement(data.value)}
          />
        </div>

        <div className="comic__card">
          <span className="comic__card-title">{t("comic.style_notes")}</span>
          <Textarea
            className="comic__textarea"
            rows={3}
            placeholder={t("comic.style_notes_placeholder")}
            value={styleNotes}
            onChange={(_e, data) => setStyleNotes(data.value)}
          />
        </div>

        <div className="comic__card comic__refs-card">
          <div className="comic__row comic__row--between">
            <span className="comic__card-title">{t("comic.reference_images")}</span>
            <div className="comic__tools">
              <Tooltip content={t("drop.tooltip.paste")} relationship="label">
                <Button
                  appearance="transparent"
                  size="small"
                  icon={<ClipboardPaste20Regular />}
                  aria-label={t("drop.tooltip.paste")}
                  onClick={() =>
                    runAsync(
                      (async () => {
                        await dropRef.current?.pasteFromClipboard();
                        await saveProjectState(false);
                      })(),
                    )
                  }
                />
              </Tooltip>
              <Tooltip content={t("drop.tooltip.clear")} relationship="label">
                <Button
                  appearance="transparent"
                  size="small"
                  icon={<Delete20Regular />}
                  aria-label={t("drop.tooltip.clear")}
                  onClick={() => {
                    dropRef.current?.clearImages();
                    void saveProjectState(false);
                  }}
                />
              </Tooltip>
            </div>
          </div>
          <ImageDropArea ref={dropRef} maxImages={14} className="comic__drop" />
        </div>

        <div className="comic__row">
          <Button
            appearance="primary"
            className="comic__grow"
            disabled={planning}
            onClick={() => runAsync(onPlanStory())}
          >
            {t("comic.plan_story")}
          </Button>
          <Button appearance="primary" className="comic__grow" onClick={() => runAsync(onGenerateAll())}>
            {t("comic.generate_all")}
          </Button>
        </div>
      </div>

      <div className="comic__center">
        <div className="comic__row comic__row--between">
          <span className="comic__card-title">{t("comic.pages_title")}</span>
          <span className="comic__caption">{planStatus ?? t("comic.no_pages")}</span>
        </div>

        {pages.length === 0 ? (
          <div className="comic__empty">{t("comic.no_pages")}</div>
        ) : (
          <div className="comic__pages-list">
            {pages.map((page, index) => (
              <div
                key={page._uid}
                className={dragOverIndex === index ? "comic__page-card comic__page-card--over" : "comic__page-card"}
                draggable
                onDragStart={() => onDragStart(index)}
                onDragOver={(event) => onDragOver(event, index)}
                onDragLeave={() => setDragOverIndex((prev) => (prev === index ? null : prev))}
                onDrop={(event) => onDrop(event, index)}
                onDragEnd={() => {
                  dragIndexRef.current = null;
                  setDragOverIndex(null);
                }}
              >
                <div className="comic__row comic__row--between">
                  <div className="comic__page-title-group">
                    <ReOrderDotsVertical20Regular className="comic__drag-handle" />
                    <span className="comic__card-title">{t("comic.page_label", { page: index + 1 })}</span>
                  </div>
                  <div className="comic__tools">
                    <Button
                      appearance="transparent"
                      size="small"
                      icon={<ArrowUp20Regular />}
                      disabled={index === 0}
                      aria-label="Move up"
                      onClick={() => movePage(index, index - 1)}
                    />
                    <Button
                      appearance="transparent"
                      size="small"
                      icon={<ArrowDown20Regular />}
                      disabled={index === pages.length - 1}
                      aria-label="Move down"
                      onClick={() => movePage(index, index + 1)}
                    />
                    <Button appearance="primary" size="small" onClick={() => runAsync(onGenerateSingle(index))}>
                      {t("comic.generate_page")}
                    </Button>
                  </div>
                </div>

                <div className="comic__field">
                  <span className="comic__caption">{t("comic.page_title")}</span>
                  <Input
                    value={page.title}
                    placeholder={t("comic.page_title_placeholder")}
                    onChange={(_e, data) => updatePage(page._uid, { title: data.value })}
                  />
                </div>

                <div className="comic__field">
                  <span className="comic__caption">{t("comic.page_story")}</span>
                  <Textarea
                    rows={3}
                    value={page.story_beat}
                    onChange={(_e, data) => updatePage(page._uid, { story_beat: data.value })}
                  />
                </div>

                <div className="comic__field">
                  <span className="comic__caption">{t("comic.page_dialogue")}</span>
                  <Textarea
                    rows={3}
                    value={page._dialogueText}
                    onChange={(_e, data) => updatePage(page._uid, { _dialogueText: data.value })}
                  />
                </div>

                <div className="comic__field">
                  <span className="comic__caption">{t("comic.page_refs")}</span>
                  <Input
                    value={page._refsText}
                    placeholder={t("comic.page_refs_placeholder")}
                    onChange={(_e, data) => updatePage(page._uid, { _refsText: data.value })}
                  />
                </div>

                <div className="comic__field">
                  <span className="comic__caption">{t("comic.page_prompt")}</span>
                  <Textarea
                    rows={4}
                    value={page.image_prompt}
                    onChange={(_e, data) => updatePage(page._uid, { image_prompt: data.value })}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="comic__right">
        <SegmentedHeader items={[{ key: "comic_task_list", label: "comic.task_list" }]} />
        <TaskListView
          list={comicTasks}
          onRegenerate={(card) => void comicTasks.regenerate(card.index, autoRetry)}
          className="comic__tasks"
        />
      </div>
    </div>
  );
}
