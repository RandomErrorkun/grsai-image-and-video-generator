/**
 * 带双层可用性状态圆点的模型下拉选择器，以及手动检测按钮（方案 B）。
 *
 * 状态圆点用纯 CSS 绘制（内实心圆 + 外浅色光环），不依赖 emoji 字体，在所有 PC 系统和亮暗主题下颜色恒定清晰。
 * 图像页、视频页、漫画页共享同一份内存状态仓，任一页点击检测按钮后三页同步更新。
 */
import { useMemo } from "react";
import { Button, Dropdown, Option, Tooltip } from "@fluentui/react-components";
import { Pulse20Regular } from "@fluentui/react-icons";
import {
  resolveModelAvailability,
  type ModelAvailabilityState,
  type ResolvedModelAvailability,
} from "../core/modelAvailability";
import { buildEffectivePricingMap, formatModelCostTag } from "../core/usageStats";
import { useTr } from "../hooks/useLanguage";
import { runAsync } from "../platform/async";
import { modelAvailability, useModelAvailability } from "../state/modelAvailability";
import { notice } from "./Notice";
import "./ModelDropdown.css";

function statusTooltip(
  info: ResolvedModelAvailability,
  t: (key: string, kwargs?: Record<string, unknown>) => string,
): string {
  if (info.state === "available") return t("model.status_available");
  if (info.state === "unknown") return t("model.status_unknown");
  if (info.maintenance) return info.maintenance;
  if (info.unlisted) return t("model.status_unlisted");
  return t("model.status_unavailable");
}

function ModelStatusDot({ state, title }: { state: ModelAvailabilityState; title: string }) {
  return <span className={`model-status-dot model-status-dot--${state}`} title={title} aria-hidden="true" />;
}

export interface ModelDropdownProps {
  value: string;
  models: readonly string[];
  ariaLabel: string;
  disabled?: boolean;
  /** 为假时不显示可用性圆点（例如漫画页使用第三方自定义 LLM 模型时）。默认 true。 */
  showAvailability?: boolean;
  className?: string;
  onChange(model: string): void;
}

export function ModelDropdown({
  value,
  models,
  ariaLabel,
  disabled = false,
  showAvailability = true,
  className,
  onChange,
}: ModelDropdownProps) {
  const t = useTr();
  const availability = useModelAvailability();
  const pricingMap = useMemo(() => buildEffectivePricingMap(availability.models), [availability.models]);
  const selectedInfo = resolveModelAvailability(value, availability);
  const selectedTitle = statusTooltip(selectedInfo, t);
  const unitPerRun = t("usage.credits_unit");
  const unitPerSec = t("model.per_second");

  return (
    <Dropdown
      className={className ? `model-dropdown ${className}` : "model-dropdown"}
      listbox={{ className: "model-dropdown__listbox" }}
      value={value}
      selectedOptions={[value]}
      aria-label={ariaLabel}
      disabled={disabled}
      button={{
        title: showAvailability ? `${value} — ${selectedTitle}` : value,
        children: (
          <span className="model-dropdown__trigger">
            {showAvailability ? <ModelStatusDot state={selectedInfo.state} title={selectedTitle} /> : null}
            <span className="model-dropdown__text">{value}</span>
          </span>
        ),
      }}
      onOptionSelect={(_event, data) => {
        if (data.optionValue) onChange(data.optionValue);
      }}
    >
      {models.map((model) => {
        const info = resolveModelAvailability(model, availability);
        const title = statusTooltip(info, t);
        const costTag = showAvailability ? formatModelCostTag(model, pricingMap, unitPerRun, unitPerSec) : null;
        return (
          <Option key={model} value={model} text={model}>
            <span className="model-dropdown__option" title={showAvailability ? title : undefined}>
              {showAvailability ? <ModelStatusDot state={info.state} title={title} /> : null}
              <span className="model-dropdown__text">{model}</span>
              {costTag ? <span className="model-dropdown__cost">{costTag}</span> : null}
            </span>
          </Option>
        );
      })}
    </Dropdown>
  );
}

/** 紧邻模型下拉框右侧的手动「检测可用性 / Check」按钮（方案 B，带 15 秒冷却与防重入）。 */
export function ModelAvailabilityButton() {
  const t = useTr();
  const { loading } = useModelAvailability();

  const onCheck = async () => {
    const result = await modelAvailability.refresh();
    switch (result.kind) {
      case "in_flight":
        return;
      case "cooldown":
        notice("info", t("common.note"), t("model.check_cooldown", { seconds: result.remainingSeconds }));
        return;
      case "ok":
        notice(
          "success",
          t("common.success"),
          t("model.check_done", { available: result.available, unavailable: result.unavailable }),
        );
        return;
      case "error":
        notice("warning", t("common.warning"), t("model.check_failed", { reason: result.message }));
        return;
    }
  };

  return (
    <Tooltip content={t("model.check_availability_tooltip")} relationship="description">
      <Button
        className="model-check-btn"
        appearance="secondary"
        icon={<Pulse20Regular />}
        disabled={loading}
        onClick={() => runAsync(onCheck())}
      >
        {t("model.check_availability")}
      </Button>
    </Tooltip>
  );
}
