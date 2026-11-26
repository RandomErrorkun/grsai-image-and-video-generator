/**
 * 图像生成页（对应 ui/generator_page.py）。
 * 显示哪些控件、各控件的选项全看模型清单里的条目。上次的选项卡、模型和参数记在配置里，
 * 写回的时刻与源项目一致：切选项卡、换模型、点生成。
 * 取值和切换的规则在 generatorView.ts，这里只负责画。
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button, Checkbox, Slider, Tooltip } from "@fluentui/react-components";
import { ClipboardPaste20Regular, Delete20Regular } from "@fluentui/react-icons";
import { FluentSelect } from "../components/FluentSelect";
import ImageDropArea from "../components/ImageDropArea";
import type { ImageDropAreaHandle } from "../components/dropAreaTypes";
import { ModelAvailabilityButton, ModelDropdown } from "../components/ModelDropdown";
import { notice } from "../components/Notice";
import PromptWidget, { type PromptWidgetHandle } from "../components/PromptWidget";
import { SegmentedHeader } from "../components/SegmentedHeader";
import { TaskListView } from "../components/TaskList";
import { DEFAULT_CONFIG } from "../core/config";
import { GPT_PIXEL_TIERS, TAB_BANANA_PRO, TAB_GPT_IMAGE, imageModelSpec } from "../core/modelCatalog";
import { useConfigValue } from "../hooks/useConfigValue";
import { useTr } from "../hooks/useLanguage";
import { runAsync } from "../platform/async";
import { cfg } from "../state/config";
import { subscribeRestore } from "../state/restore";
import { localFiles } from "../state/services";
import { generatorTasks } from "../state/taskLists";
import {
  PARALLEL_MAX,
  PARALLEL_MIN,
  changeModel,
  changeTab,
  initialState,
  modelControls,
  parallelTasksOf,
  refImagesOf,
  restoreTask,
  tabModels,
  taskCount,
  taskParams,
  type GeneratorState,
  type GeneratorTab,
} from "./generatorView";
import "./GeneratorPage.css";

/** 参考图上限，与源项目一致。 */
const MAX_REF_IMAGES = 14;

/** 标题在左、控件占满剩余宽度，与视频页的参数行保持一致。 */
function Field({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="generator__field">
      <span className="generator__caption">{caption}</span>
      <div className="generator__control">{children}</div>
    </div>
  );
}

export default function GeneratorPage() {
  const t = useTr();
  const [form, setForm] = useState<GeneratorState>(() => initialState(cfg));
  const [autoRetry, setAutoRetry] = useState(
    () => cfg.get("auto_retry_on_failure", DEFAULT_CONFIG.auto_retry_on_failure) === true,
  );
  const [parallel, setParallel] = useState(() => parallelTasksOf(cfg.get("parallel_tasks", DEFAULT_CONFIG.parallel_tasks)));
  const vipModerationRetry =
    useConfigValue("vip_moderation_auto_retry", DEFAULT_CONFIG.vip_moderation_auto_retry) === true;
  const promptRef = useRef<PromptWidgetHandle>(null);
  const dropRef = useRef<ImageDropAreaHandle>(null);

  // 条目属于哪张表，参数行就按哪个系列画
  const spec = imageModelSpec(form.model);
  const banana = spec && "sizes" in spec ? spec : null;
  const gpt = spec && !("sizes" in spec) ? spec : null;
  const controls = modelControls(form.model);

  // 与源项目一致：页面建好时等于切了一次选项卡，认不出的旧值在这里写回配置
  useEffect(() => {
    cfg.set("last_tab", form.tab);
    cfg.set(`last_model_tab_${form.tab}`, form.model);
  }, []);

  // 恢复请求要按表单最新的一份来算，所以每次渲染后更新这个引用
  const formRef = useRef(form);
  useEffect(() => {
    formRef.current = form;
  });

  // 历史页的「重新生成」：只回填，不提交
  useEffect(() =>
    subscribeRestore((request) => {
      if (request.page !== "generator") return;
      setForm(restoreTask(formRef.current, request.task, cfg));
      promptRef.current?.setPrompt(request.task.prompt);
      const paths = refImagesOf(request.task);
      // 对应源项目：先清空，再按记录里的顺序加回来
      dropRef.current?.clearImages();
      runAsync(addImages(dropRef, paths));
    }), []);

  const onTabChange = (key: string) => {
    const tab: GeneratorTab = key === TAB_GPT_IMAGE ? TAB_GPT_IMAGE : TAB_BANANA_PRO;
    setForm(changeTab(form, tab, cfg));
  };

  const generate = async () => {
    const prompt = promptRef.current?.getPrompt() ?? "";
    if (!prompt) {
      notice("warning", t("common.warning"), t("generator.enter_prompt_warning"));
      return;
    }
    // 参数和开关在这一刻定下来：查参考图要等文件系统，回来之前表单可能已经变了
    const params = taskParams(form, cfg);
    cfg.set("auto_retry_on_failure", autoRetry);
    cfg.set("parallel_tasks", parallel);
    const total = taskCount(parallel);
    const paths = dropRef.current?.getPaths() ?? [];
    // 只带还在磁盘上的本地文件，与源项目的 os.path.isfile 一致
    const isLocal = await Promise.all(paths.map((path) => localFiles.isFile(path).catch(() => false)));
    const refImageUrls = paths.filter((_path, index) => isLocal[index]);
    for (let index = 0; index < total; index += 1) {
      generatorTasks.create({ prompt, spec: { prompt, ...params, refImageUrls }, autoRetry });
    }
  };

  const update = (patch: Partial<GeneratorState>) => setForm({ ...form, ...patch });

  return (
    <div className="page generator">
      <div className="generator__main">
        <SegmentedHeader
          items={[
            { key: TAB_BANANA_PRO, label: "generator.tab.banana_pro" },
            { key: TAB_GPT_IMAGE, label: "generator.tab.gpt_image" },
          ]}
          value={form.tab}
          onChange={onTabChange}
        />

        <div className="generator__card">
          <div className="generator__row">
            <Field caption={t("generator.model")}>
              <ModelDropdown
                value={form.model}
                models={tabModels(form.tab)}
                ariaLabel={t("generator.model")}
                onChange={(model) => setForm(changeModel(form, model, cfg))}
              />
            </Field>
            <ModelAvailabilityButton />
          </div>

          {banana ? (
            <div className="generator__row">
              <Field caption={t("generator.aspect_ratio")}>
                <FluentSelect
                  value={form.ratio}
                  options={banana.ratios}
                  ariaLabel={t("generator.aspect_ratio")}
                  onChange={(ratio) => update({ ratio })}
                />
              </Field>
              <Field caption={t("generator.image_size")}>
                <FluentSelect
                  value={form.size}
                  options={banana.sizes}
                  ariaLabel={t("generator.image_size")}
                  onChange={(size) => update({ size })}
                />
              </Field>
            </div>
          ) : null}

          {gpt ? (
            <div className="generator__row">
              <Field caption={t("generator.gpt_size")}>
                <FluentSelect
                  value={form.gptRatio}
                  options={gpt.ratios}
                  ariaLabel={t("generator.gpt_size")}
                  onChange={(gptRatio) => update({ gptRatio })}
                />
              </Field>
              {controls.quality ? (
                <Field caption={t("generator.gpt_quality")}>
                  <FluentSelect
                    value={form.quality}
                    options={gpt.qualities}
                    ariaLabel={t("generator.gpt_quality")}
                    onChange={(quality) => update({ quality })}
                  />
                </Field>
              ) : null}
            </div>
          ) : null}

          {controls.tier || controls.transparent ? (
            <div className="generator__row">
              {controls.tier ? (
                <Field caption={t("generator.gpt_tier")}>
                  <FluentSelect
                    value={form.tier}
                    options={GPT_PIXEL_TIERS}
                    ariaLabel={t("generator.gpt_tier")}
                    onChange={(tier) => update({ tier })}
                  />
                </Field>
              ) : null}
              {controls.transparent ? (
                <div className="generator__field">
                  <Checkbox
                    className="generator__checkbox"
                    label={t("generator.transparent_bg")}
                    checked={form.transparent}
                    onChange={(_event, data) => update({ transparent: data.checked === true })}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {controls.format && gpt?.outputFormats ? (
            <div className="generator__row">
              <Field caption={t("generator.gpt_output_format")}>
                <FluentSelect
                  value={form.format}
                  options={gpt.outputFormats}
                  ariaLabel={t("generator.gpt_output_format")}
                  onChange={(format) => update({ format })}
                />
              </Field>
            </div>
          ) : null}

          <div className="generator__row generator__row--retry">
            <Checkbox
              className="generator__retry"
              label={t("generator.auto_retry")}
              checked={autoRetry}
              onChange={(_event, data) => setAutoRetry(data.checked === true)}
            />
            <div className="generator__parallel">
              <span>{t("generator.parallel_tasks")}</span>
              <Slider
                className="generator__slider"
                min={PARALLEL_MIN}
                max={PARALLEL_MAX}
                step={1}
                value={parallel}
                aria-label={t("generator.parallel_tasks")}
                onChange={(_event, data) => setParallel(data.value)}
              />
              <span className="generator__parallel-value">{parallel}</span>
            </div>
          </div>

          {controls.vip ? (
            <p className="generator__hint">
              {t(vipModerationRetry ? "generator.vip_hint_enabled" : "generator.vip_hint_disabled")}
            </p>
          ) : null}
        </div>

        <div className="generator__middle">
          <div className="generator__images">
            <div className="generator__images-header">
              <span className="generator__section-title">{t("generator.reference_images")}</span>
              <div className="generator__tools">
                <Tooltip content={t("drop.tooltip.paste")} relationship="label">
                  <Button
                    appearance="transparent"
                    size="small"
                    icon={<ClipboardPaste20Regular />}
                    aria-label={t("drop.tooltip.paste")}
                    onClick={() => runAsync(dropRef.current?.pasteFromClipboard() ?? Promise.resolve())}
                  />
                </Tooltip>
                <Tooltip content={t("drop.tooltip.clear")} relationship="label">
                  <Button
                    appearance="transparent"
                    size="small"
                    icon={<Delete20Regular />}
                    aria-label={t("drop.tooltip.clear")}
                    onClick={() => dropRef.current?.clearImages()}
                  />
                </Tooltip>
              </div>
            </div>
            <ImageDropArea ref={dropRef} maxImages={MAX_REF_IMAGES} className="generator__drop" />
          </div>
          <PromptWidget ref={promptRef} className="generator__prompt" />
        </div>

        <Button appearance="primary" size="large" className="generator__generate" onClick={() => runAsync(generate())}>
          {t("generator.generate")}
        </Button>
      </div>

      <div className="generator__side">
        <SegmentedHeader items={[{ key: "task_list", label: "generator.task_list" }]} />
        <TaskListView
          list={generatorTasks}
          onRegenerate={(card) => void generatorTasks.regenerate(card.index, autoRetry)}
          className="generator__tasks"
        />
      </div>
    </div>
  );
}

/** 对应 regenerate_task：把记录里的参考图按顺序加回去。 */
async function addImages(drop: RefObject<ImageDropAreaHandle | null>, paths: readonly string[]): Promise<void> {
  for (const path of paths) await drop.current?.addImage(path);
}
