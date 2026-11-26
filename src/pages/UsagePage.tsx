/**
 * 用量统计页：
 * - GitHub Contributions 风格全年积分消耗热力图（每列周日到周六，主题色 5 档深浅）；
 * - 总用量 KPI 与按生成类型 / 按模型的交互式环形扇形图（不含文本模型）；
 * - 支持最近 7 天 / 最近 30 天 / 指定时间段的单天用量折线图与分模型堆积柱状图；
 * - 复用 modelAvailability 的官网实时定价，同时内置完整默认价目表开箱即用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Select, Tooltip } from "@fluentui/react-components";
import { ArrowSync20Regular, Pulse20Regular } from "@fluentui/react-icons";
import { notice } from "../components/Notice";
import type { UsageLedgerRecord } from "../core/history";
import {
  OTHER_MODEL_KEY,
  aggregateByDate,
  availableYears,
  buildDailyUsageSeries,
  buildModelDistribution,
  buildTypeDistribution,
  buildYearHeatmap,
  filterEntriesByRange,
  formatCompactCredits,
  formatCredits,
  ledgerToUsageEntries,
  resolveAllRecordsRange,
  resolvePresetRange,
  type DailySeriesPoint,
  type DailyUsageSeries,
  type DistributionSlice,
  type HeatmapCell,
  type RangePreset,
  type YearHeatmap,
} from "../core/usageStats";
import { useTr } from "../hooks/useLanguage";
import { normalizeLanguage } from "../i18n";
import { useConfigValue } from "../hooks/useConfigValue";
import { runAsync } from "../platform/async";
import { modelAvailability, useModelAvailability } from "../state/modelAvailability";
import { backfillUsageLedger, openHistory, subscribeHistoryChanged } from "../state/services";
import "./UsagePage.css";

/** 扇形图与堆积柱状图共用的高对比调色板（亮暗主题下均清晰易区分）。 */
const CHART_PALETTE = [
  "#0078D4",
  "#10B981",
  "#F59E0B",
  "#8B5CF6",
  "#EC4899",
  "#06B6D4",
  "#EF4444",
  "#64748B",
] as const;

const MONTHS_ZH = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS_ZH = ["日", "一", "二", "三", "四", "五", "六"];
const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function colorForModel(key: string, index: number): string {
  if (key === OTHER_MODEL_KEY) return "#94A3B8";
  return CHART_PALETTE[index % CHART_PALETTE.length];
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number): [number, number] {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** 构造环形扇区 SVG path；整圆（>= 359.99°）改用两个半圆避免首尾重合画不出来。 */
function donutArcPath(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startDeg: number,
  endDeg: number,
): string {
  const sweep = endDeg - startDeg;
  if (sweep >= 359.99) {
    return (
      donutArcPath(cx, cy, outerR, innerR, startDeg, startDeg + 180) +
      " " +
      donutArcPath(cx, cy, outerR, innerR, startDeg + 180, startDeg + 359.98)
    );
  }
  const [ox1, oy1] = polarToCartesian(cx, cy, outerR, startDeg);
  const [ox2, oy2] = polarToCartesian(cx, cy, outerR, endDeg);
  const [ix2, iy2] = polarToCartesian(cx, cy, innerR, endDeg);
  const [ix1, iy1] = polarToCartesian(cx, cy, innerR, startDeg);
  const large = sweep > 180 ? 1 : 0;
  return `M ${ox1} ${oy1} A ${outerR} ${outerR} 0 ${large} 1 ${ox2} ${oy2} L ${ix2} ${iy2} A ${innerR} ${innerR} 0 ${large} 0 ${ix1} ${iy1} Z`;
}

/** 根据区间天数挑出不互相重叠的 X 轴刻度下标。 */
function pickTickIndices(length: number, maxTicks: number): number[] {
  if (length <= 0) return [];
  if (length <= maxTicks) return Array.from({ length }, (_, i) => i);
  const step = Math.ceil((length - 1) / (maxTicks - 1));
  const indices: number[] = [];
  for (let i = 0; i < length; i += step) indices.push(i);
  if (indices[indices.length - 1] !== length - 1) indices.push(length - 1);
  return indices;
}

/** 把 YYYY-MM-DD 缩短成 MM-DD 方便在 X 轴紧凑显示。 */
const shortDate = (date: string) => date.slice(5);

/** 向上取一个好看的 Y 轴整刻度上限。 */
function niceUpperBound(maxValue: number): number {
  if (maxValue <= 0) return 1000;
  const pow = 10 ** Math.floor(Math.log10(maxValue));
  const norm = maxValue / pow;
  const mult = norm <= 1.2 ? 1.2 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return Math.ceil(mult * pow);
}

/* ---------- 子组件：全年 GitHub Contributions 风格热力图 ---------- */

function YearlyHeatmapCard({
  heatmap,
  years,
  language,
  onYearChange,
}: {
  heatmap: YearHeatmap;
  years: readonly number[];
  language: "en" | "zh";
  onYearChange(year: number): void;
}) {
  const t = useTr();
  const [hovered, setHovered] = useState<HeatmapCell | null>(null);
  const months = language === "zh" ? MONTHS_ZH : MONTHS_EN;
  const weekdays = language === "zh" ? WEEKDAYS_ZH : WEEKDAYS_EN;

  const cellSize = 12;
  const cellGap = 3;
  const step = cellSize + cellGap;
  const leftPad = 26;
  const topPad = 18;
  const svgWidth = leftPad + heatmap.weeks.length * step + 4;
  const svgHeight = topPad + 7 * step + 4;

  return (
    <section className="usage-card">
      <div className="usage-card__header">
        <div className="usage-card__title-group">
          <h3 className="usage-card__title">{t("usage.heatmap.title")}</h3>
          <span className="usage-card__subtitle">
            {hovered
              ? t("usage.heatmap.cell_tip", {
                  date: hovered.date,
                  credits: formatCredits(hovered.credits),
                  count: hovered.count,
                })
              : t("usage.heatmap.summary", {
                  year: heatmap.year,
                  credits: formatCredits(heatmap.totalCredits),
                  days: heatmap.activeDays,
                })}
          </span>
        </div>
        <div className="usage-heatmap__controls">
          <div className="usage-heatmap__legend" aria-hidden="true">
            <span>{t("usage.heatmap.less")}</span>
            {([0, 1, 2, 3, 4] as const).map((level) => (
              <span key={level} className={`usage-heatmap__swatch usage-heatmap__swatch--l${level}`} />
            ))}
            <span>{t("usage.heatmap.more")}</span>
          </div>
          <Select
            className="usage-year-select"
            size="small"
            aria-label="Year"
            value={String(heatmap.year)}
            onChange={(_e, data) => onYearChange(Number(data.value))}
          >
            {years.map((y) => (
              <option key={y} value={String(y)}>
                {y}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="usage-heatmap__scroll">
        <svg
          className="usage-heatmap__svg"
          width={svgWidth}
          height={svgHeight}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          role="img"
          aria-label={t("usage.heatmap.title")}
        >
          {/* 月份标签 */}
          {heatmap.monthLabels.map((m) => (
            <text
              key={m.month}
              x={leftPad + m.weekIndex * step}
              y={11}
              className="usage-axis-text"
            >
              {months[m.month]}
            </text>
          ))}
          {/* 星期标签：仅标 周一 / 周三 / 周五，清爽不拥挤 */}
          {[1, 3, 5].map((dow) => (
            <text
              key={dow}
              x={leftPad - 6}
              y={topPad + dow * step + cellSize - 2}
              textAnchor="end"
              className="usage-axis-text"
            >
              {weekdays[dow]}
            </text>
          ))}
          {/* 全年方格矩阵：每列 7 格，周日(0) 在最上，周六(6) 在最下 */}
          {heatmap.weeks.map((week, weekIdx) =>
            week.map((cell, dow) => {
              if (!cell) return null;
              const tip = t("usage.heatmap.cell_tip", {
                date: cell.date,
                credits: formatCredits(cell.credits),
                count: cell.count,
              });
              return (
                <rect
                  key={cell.date}
                  x={leftPad + weekIdx * step}
                  y={topPad + dow * step}
                  width={cellSize}
                  height={cellSize}
                  rx={2.5}
                  ry={2.5}
                  className={`usage-heatmap__cell usage-heatmap__cell--l${cell.level}`}
                  onMouseEnter={() => setHovered(cell)}
                  onMouseLeave={() => setHovered((cur) => (cur?.date === cell.date ? null : cur))}
                >
                  <title>{tip}</title>
                </rect>
              );
            }),
          )}
        </svg>
      </div>
    </section>
  );
}

/* ---------- 子组件：交互式环形扇形图 ---------- */

function DonutChartCard({
  title,
  slices,
  labelOf,
  colorOf,
  emptyText,
}: {
  title: string;
  slices: readonly DistributionSlice[];
  labelOf(key: string): string;
  colorOf(key: string, index: number): string;
  emptyText: string;
}) {
  const t = useTr();
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const totalCredits = useMemo(() => slices.reduce((sum, s) => sum + s.credits, 0), [slices]);
  const hovered = slices.find((s) => s.key === hoverKey) ?? null;

  const arcs = useMemo(() => {
    let angle = 0;
    return slices.map((slice, idx) => {
      const start = angle;
      const sweep = slice.share * 360;
      angle += sweep;
      return {
        slice,
        color: colorOf(slice.key, idx),
        path: donutArcPath(84, 84, 72, 46, start, start + sweep),
      };
    });
  }, [slices, colorOf]);

  return (
    <section className="usage-card usage-donut-card">
      <div className="usage-card__header">
        <h3 className="usage-card__title">{title}</h3>
      </div>
      {slices.length === 0 ? (
        <div className="usage-empty">{emptyText}</div>
      ) : (
        <div className="usage-donut__body">
          <div className="usage-donut__chart">
            <svg width={168} height={168} viewBox="0 0 168 168" role="img" aria-label={title}>
              {arcs.map(({ slice, color, path }) => {
                const active = hoverKey === null || hoverKey === slice.key;
                return (
                  <path
                    key={slice.key}
                    d={path}
                    fill={color}
                    opacity={active ? 1 : 0.35}
                    className="usage-donut__slice"
                    onMouseEnter={() => setHoverKey(slice.key)}
                    onMouseLeave={() => setHoverKey(null)}
                  >
                    <title>
                      {labelOf(slice.key)}: {formatCredits(slice.credits)} {t("usage.credits_unit")} (
                      {(slice.share * 100).toFixed(1)}%)
                    </title>
                  </path>
                );
              })}
              <text x={84} y={79} textAnchor="middle" className="usage-donut__center-value">
                {formatCompactCredits(hovered ? hovered.credits : totalCredits)}
              </text>
              <text x={84} y={97} textAnchor="middle" className="usage-donut__center-label">
                {hovered ? `${(hovered.share * 100).toFixed(1)}%` : t("usage.credits_unit")}
              </text>
            </svg>
          </div>
          <ul className="usage-donut__legend">
            {slices.map((slice, idx) => {
              const color = colorOf(slice.key, idx);
              const isHover = hoverKey === slice.key;
              return (
                <li
                  key={slice.key}
                  className={isHover ? "usage-donut__legend-item usage-donut__legend-item--active" : "usage-donut__legend-item"}
                  onMouseEnter={() => setHoverKey(slice.key)}
                  onMouseLeave={() => setHoverKey(null)}
                >
                  <span className="usage-legend-dot" style={{ background: color }} />
                  <span className="usage-donut__legend-name" title={labelOf(slice.key)}>
                    {labelOf(slice.key)}
                  </span>
                  <span className="usage-donut__legend-val">
                    {formatCredits(slice.credits)}
                  </span>
                  <span className="usage-donut__legend-pct">{(slice.share * 100).toFixed(1)}%</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

/* ---------- 子组件：单天用量折线图 ---------- */

function DailyLineChartCard({ series }: { series: DailyUsageSeries }) {
  const t = useTr();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const points = series.points;
  const width = 640;
  const height = 220;
  const pad = { top: 14, right: 16, bottom: 28, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const yMax = niceUpperBound(series.maxDailyCredits);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    value: Math.round(yMax * ratio),
    y: pad.top + plotH * (1 - ratio),
  }));

  const xOf = (idx: number) =>
    points.length <= 1 ? pad.left + plotW / 2 : pad.left + (idx / (points.length - 1)) * plotW;
  const yOf = (val: number) => pad.top + plotH * (1 - Math.min(1, val / yMax));

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(i).toFixed(1)} ${yOf(p.totalCredits).toFixed(1)}`)
    .join(" ");
  const areaPath =
    points.length > 0
      ? `${linePath} L ${xOf(points.length - 1).toFixed(1)} ${(pad.top + plotH).toFixed(1)} L ${xOf(0).toFixed(1)} ${(pad.top + plotH).toFixed(1)} Z`
      : "";

  const xTickIndices = pickTickIndices(points.length, 7);
  const hovered: DailySeriesPoint | null = hoverIdx !== null ? (points[hoverIdx] ?? null) : null;

  return (
    <section className="usage-card">
      <div className="usage-card__header">
        <div className="usage-card__title-group">
          <h3 className="usage-card__title">{t("usage.line.title")}</h3>
          <span className="usage-card__subtitle">
            {hovered
              ? `${hovered.date} · ${formatCredits(hovered.totalCredits)} ${t("usage.credits_unit")} (${hovered.totalCount})`
              : `${series.start} ~ ${series.end} · ${formatCredits(series.totalCredits)} ${t("usage.credits_unit")}`}
          </span>
        </div>
      </div>

      {points.length === 0 || series.totalCredits === 0 ? (
        <div className="usage-empty">{t("usage.empty")}</div>
      ) : (
        <div className="usage-chart-wrap">
          <svg
            className="usage-chart-svg"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={t("usage.line.title")}
          >
            <defs>
              <linearGradient id="usageLineArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {/* 水平网格线与 Y 轴刻度 */}
            {yTicks.map((tick) => (
              <g key={tick.value}>
                <line x1={pad.left} y1={tick.y} x2={width - pad.right} y2={tick.y} className="usage-grid-line" />
                <text x={pad.left - 8} y={tick.y + 4} textAnchor="end" className="usage-axis-text">
                  {formatCompactCredits(tick.value)}
                </text>
              </g>
            ))}
            {/* 面积与折线 */}
            <path d={areaPath} fill="url(#usageLineArea)" />
            <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />

            {/* 悬停垂线与数据点 */}
            {hoverIdx !== null && hovered ? (
              <line
                x1={xOf(hoverIdx)}
                y1={pad.top}
                x2={xOf(hoverIdx)}
                y2={pad.top + plotH}
                className="usage-hover-guide"
              />
            ) : null}

            {points.map((p, idx) => {
              const cx = xOf(idx);
              const cy = yOf(p.totalCredits);
              const showDot = points.length <= 31 || hoverIdx === idx;
              const colW = points.length <= 1 ? plotW : plotW / (points.length - 1);
              return (
                <g key={p.date}>
                  {showDot ? (
                    <circle
                      cx={cx}
                      cy={cy}
                      r={hoverIdx === idx ? 4.5 : 2.6}
                      fill="var(--accent)"
                      stroke="var(--card-bg)"
                      strokeWidth={1.5}
                    />
                  ) : null}
                  {/* 透明宽点击/悬停命中条，鼠标滑过即可精确聚焦该日 */}
                  <rect
                    x={Math.max(pad.left, cx - colW / 2)}
                    y={pad.top}
                    width={Math.max(4, colW)}
                    height={plotH}
                    fill="transparent"
                    onMouseEnter={() => setHoverIdx(idx)}
                    onMouseLeave={() => setHoverIdx((cur) => (cur === idx ? null : cur))}
                  >
                    <title>
                      {p.date}: {formatCredits(p.totalCredits)} {t("usage.credits_unit")} ({p.totalCount})
                    </title>
                  </rect>
                </g>
              );
            })}

            {/* X 轴日期刻度 */}
            {xTickIndices.map((idx) => (
              <text
                key={points[idx].date}
                x={xOf(idx)}
                y={height - 8}
                textAnchor={idx === 0 ? "start" : idx === points.length - 1 ? "end" : "middle"}
                className="usage-axis-text"
              >
                {shortDate(points[idx].date)}
              </text>
            ))}
          </svg>
        </div>
      )}
    </section>
  );
}

/* ---------- 子组件：通用时间段筛选条 ---------- */

const PRESET_BUTTONS: readonly ("7d" | "30d" | "all")[] = ["7d", "30d", "all"];

function RangeFilterBar({
  preset,
  startDate,
  endDate,
  onPresetClick,
  onStartChange,
  onEndChange,
}: {
  preset: RangePreset;
  startDate: string;
  endDate: string;
  onPresetClick(next: "7d" | "30d" | "all"): void;
  onStartChange(date: string): void;
  onEndChange(date: string): void;
}) {
  const t = useTr();
  return (
    <section className="usage-range-bar">
      <div className="usage-range-bar__presets" role="group">
        {PRESET_BUTTONS.map((item) => (
          <Button
            key={item}
            size="small"
            appearance={preset === item ? "primary" : "secondary"}
            onClick={() => onPresetClick(item)}
          >
            {t(`usage.range.${item}`)}
          </Button>
        ))}
      </div>
      <div className="usage-range-bar__dates">
        <input
          type="date"
          className="usage-date-input"
          value={startDate}
          onChange={(e) => {
            if (e.target.value) onStartChange(e.target.value);
          }}
        />
        <span className="usage-range-bar__sep">{t("usage.range.to")}</span>
        <input
          type="date"
          className="usage-date-input"
          value={endDate}
          onChange={(e) => {
            if (e.target.value) onEndChange(e.target.value);
          }}
        />
      </div>
    </section>
  );
}

/* ---------- 子组件：单天分模型堆积柱状图 ---------- */

function StackedBarChartCard({
  series,
  modelColorMap,
  labelOf,
}: {
  series: DailyUsageSeries;
  modelColorMap: ReadonlyMap<string, string>;
  labelOf(key: string): string;
}) {
  const t = useTr();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const points = series.points;
  const width = 640;
  const height = 220;
  const pad = { top: 14, right: 16, bottom: 28, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const yMax = niceUpperBound(series.maxDailyCredits);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    value: Math.round(yMax * ratio),
    y: pad.top + plotH * (1 - ratio),
  }));

  const slotW = points.length > 0 ? plotW / points.length : plotW;
  const barW = Math.max(2, Math.min(28, slotW * 0.68));
  const xTickIndices = pickTickIndices(points.length, 7);
  const hovered = hoverIdx !== null ? (points[hoverIdx] ?? null) : null;

  const hoveredRows = useMemo(() => {
    if (!hovered) return [];
    return series.models
      .map((model) => ({ model, credits: hovered.byModel[model] ?? 0 }))
      .filter((item) => item.credits > 0)
      .sort((a, b) => b.credits - a.credits);
  }, [hovered, series.models]);

  // 计算向上弹出悬浮窗的定位（紧贴当前柱子顶部上方，左右自动避让边缘防裁切）
  const popoverStyle = useMemo(() => {
    if (hoverIdx === null || !hovered) return null;
    const centerX = pad.left + hoverIdx * slotW + slotW / 2;
    const leftPct = (centerX / width) * 100;
    const barRatio = Math.min(1, hovered.totalCredits / yMax);
    const barTopY = pad.top + plotH * (1 - barRatio);
    const bottomPct = Math.max(12, Math.min(96, ((height - barTopY) / height) * 100));
    if (leftPct < 24) {
      return { left: "0%", bottom: `${bottomPct.toFixed(1)}%`, transform: "none" };
    }
    if (leftPct > 76) {
      return { right: "0%", bottom: `${bottomPct.toFixed(1)}%`, transform: "none" };
    }
    return { left: `${leftPct.toFixed(1)}%`, bottom: `${bottomPct.toFixed(1)}%`, transform: "translateX(-50%)" };
  }, [hoverIdx, hovered, pad.left, pad.top, plotH, slotW, yMax]);

  return (
    <section className="usage-card usage-stacked-card">
      <div className="usage-card__header">
        <div className="usage-card__title-group">
          <h3 className="usage-card__title">{t("usage.stacked.title")}</h3>
          <span className="usage-card__subtitle">
            {formatCredits(series.totalCredits)} {t("usage.credits_unit")}
          </span>
        </div>
      </div>

      {points.length === 0 || series.totalCredits === 0 ? (
        <div className="usage-empty">{t("usage.empty")}</div>
      ) : (
        <>
          <div className="usage-chart-wrap usage-chart-wrap--popover">
            {hovered && popoverStyle ? (
              <div className="usage-bar-popover" style={popoverStyle} role="tooltip">
                <div className="usage-bar-popover__head">
                  <span className="usage-bar-popover__date">{hovered.date}</span>
                  <span className="usage-bar-popover__total">
                    {formatCredits(hovered.totalCredits)} {t("usage.credits_unit")}
                  </span>
                </div>
                {hoveredRows.length > 0 ? (
                  <ul className="usage-bar-popover__list">
                    {hoveredRows.map(({ model, credits }) => (
                      <li key={model} className="usage-bar-popover__row">
                        <span
                          className="usage-legend-dot"
                          style={{ background: modelColorMap.get(model) ?? CHART_PALETTE[0] }}
                        />
                        <span className="usage-bar-popover__name">{labelOf(model)}</span>
                        <span className="usage-bar-popover__val">{formatCredits(credits)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <svg
              className="usage-chart-svg"
              viewBox={`0 0 ${width} ${height}`}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label={t("usage.stacked.title")}
            >
              {yTicks.map((tick) => (
                <g key={tick.value}>
                  <line x1={pad.left} y1={tick.y} x2={width - pad.right} y2={tick.y} className="usage-grid-line" />
                  <text x={pad.left - 8} y={tick.y + 4} textAnchor="end" className="usage-axis-text">
                    {formatCompactCredits(tick.value)}
                  </text>
                </g>
              ))}

              {points.map((p, idx) => {
                const slotX = pad.left + idx * slotW;
                const barX = slotX + (slotW - barW) / 2;
                let accY = pad.top + plotH;
                const isHover = hoverIdx === idx;

                return (
                  <g
                    key={p.date}
                    onMouseEnter={() => setHoverIdx(idx)}
                    onMouseLeave={() => setHoverIdx((cur) => (cur === idx ? null : cur))}
                  >
                    {isHover ? (
                      <rect
                        x={slotX}
                        y={pad.top}
                        width={slotW}
                        height={plotH}
                        className="usage-bar-highlight"
                      />
                    ) : null}
                    {series.models.map((model) => {
                      const val = p.byModel[model] ?? 0;
                      if (val <= 0) return null;
                      const segH = Math.max(1, (val / yMax) * plotH);
                      accY -= segH;
                      return (
                        <rect
                          key={model}
                          x={barX}
                          y={accY}
                          width={barW}
                          height={segH}
                          fill={modelColorMap.get(model) ?? CHART_PALETTE[0]}
                          opacity={hoverIdx === null || isHover ? 1 : 0.55}
                        />
                      );
                    })}
                    <rect x={slotX} y={pad.top} width={slotW} height={plotH} fill="transparent" />
                  </g>
                );
              })}

              {xTickIndices.map((idx) => (
                <text
                  key={points[idx].date}
                  x={pad.left + idx * slotW + slotW / 2}
                  y={height - 8}
                  textAnchor="middle"
                  className="usage-axis-text"
                >
                  {shortDate(points[idx].date)}
                </text>
              ))}
            </svg>
          </div>
          <div className="usage-stacked__legend">
            {series.models.map((model) => (
              <span key={model} className="usage-stacked__legend-item">
                <span className="usage-legend-dot" style={{ background: modelColorMap.get(model) ?? CHART_PALETTE[0] }} />
                <span>{labelOf(model)}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/* ---------- 主页面 ---------- */

export default function UsagePage() {
  const t = useTr();
  const language = normalizeLanguage(useConfigValue("language", "en"));
  const availability = useModelAvailability();

  const [ledger, setLedger] = useState<UsageLedgerRecord[]>([]);
  const [selectedYear, setSelectedYear] = useState(() => new Date().getFullYear());
  const initialRange = useMemo(() => resolvePresetRange("30d"), []);
  // 扇形图独立时间范围，默认「全部记录」
  const [piePreset, setPiePreset] = useState<RangePreset>("all");
  const [pieCustomStart, setPieCustomStart] = useState(initialRange.start);
  const [pieCustomEnd, setPieCustomEnd] = useState(initialRange.end);
  // 折线图与堆积柱状图时间范围，默认「最近 30 天」
  const [preset, setPreset] = useState<RangePreset>("30d");
  const [customStart, setCustomStart] = useState(initialRange.start);
  const [customEnd, setCustomEnd] = useState(initialRange.end);

  const rootRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(false);
  const loadToken = useRef(0);

  const loadUsage = useCallback(async () => {
    const token = ++loadToken.current;
    await backfillUsageLedger();
    const history = await openHistory();
    const rows = await history.getUsageEvents();
    if (token !== loadToken.current) return;
    setLedger(rows);
  }, []);

  // 每次切到本页或历史库变化时自动刷新数据
  useEffect(() => {
    const element = rootRef.current;
    const reload = () => runAsync(loadUsage());
    if (!element || typeof IntersectionObserver === "undefined") {
      visibleRef.current = true;
      reload();
      return;
    }
    let shown = false;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      visibleRef.current = visible;
      if (visible && !shown) reload();
      shown = visible;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [loadUsage]);

  useEffect(
    () =>
      subscribeHistoryChanged(() => {
        if (visibleRef.current) runAsync(loadUsage());
      }),
    [loadUsage],
  );

  const entries = useMemo(() => ledgerToUsageEntries(ledger), [ledger]);
  const dailyMap = useMemo(() => aggregateByDate(entries), [entries]);

  const currentYear = new Date().getFullYear();
  const years = useMemo(() => availableYears(entries, currentYear), [entries, currentYear]);
  const effectiveYear = years.includes(selectedYear) ? selectedYear : years[0];
  const heatmap = useMemo(() => buildYearHeatmap(effectiveYear, dailyMap), [effectiveYear, dailyMap]);

  const allRecordsRange = useMemo(() => resolveAllRecordsRange(entries), [entries]);

  const pieRange = useMemo(() => {
    if (piePreset === "7d" || piePreset === "30d") return resolvePresetRange(piePreset);
    if (piePreset === "all") return allRecordsRange;
    return { start: pieCustomStart, end: pieCustomEnd };
  }, [piePreset, pieCustomStart, pieCustomEnd, allRecordsRange]);

  const pieEntries = useMemo(
    () => (piePreset === "all" ? entries : filterEntriesByRange(entries, pieRange.start, pieRange.end)),
    [entries, piePreset, pieRange.start, pieRange.end],
  );

  const typeSlices = useMemo(() => buildTypeDistribution(pieEntries), [pieEntries]);
  const modelSlices = useMemo(() => buildModelDistribution(pieEntries, 7), [pieEntries]);

  const totalCredits = useMemo(() => entries.reduce((sum, e) => sum + (e.charged ? e.credits : 0), 0), [entries]);
  const totalRuns = useMemo(() => entries.filter((e) => e.charged).length, [entries]);
  const imageRuns = useMemo(() => entries.filter((e) => e.charged && e.kind === "image").length, [entries]);
  const videoRuns = useMemo(() => entries.filter((e) => e.charged && e.kind === "video").length, [entries]);

  const activeRange = useMemo(() => {
    if (preset === "7d" || preset === "30d") return resolvePresetRange(preset);
    if (preset === "all") return allRecordsRange;
    return { start: customStart, end: customEnd };
  }, [preset, customStart, customEnd, allRecordsRange]);

  const dailySeries = useMemo(
    () => buildDailyUsageSeries(entries, activeRange.start, activeRange.end, 6),
    [entries, activeRange.start, activeRange.end],
  );

  // 统一所有模型在饼图与堆积柱状图里的配色，方便用户对照
  const modelColorMap = useMemo(() => {
    const map = new Map<string, string>();
    let idx = 0;
    for (const s of modelSlices) {
      if (!map.has(s.key)) {
        map.set(s.key, colorForModel(s.key, idx));
        if (s.key !== OTHER_MODEL_KEY) idx += 1;
      }
    }
    for (const m of dailySeries.models) {
      if (!map.has(m)) {
        map.set(m, colorForModel(m, idx));
        if (m !== OTHER_MODEL_KEY) idx += 1;
      }
    }
    return map;
  }, [modelSlices, dailySeries.models]);

  const modelLabel = useCallback(
    (key: string) => (key === OTHER_MODEL_KEY ? t("usage.other_models") : key),
    [t],
  );

  const typeLabel = useCallback(
    (key: string) => (key === "video" ? t("usage.type.video") : t("usage.type.image")),
    [t],
  );

  const onSyncPricing = async () => {
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
    <div ref={rootRef} className="page usage-page">
      <div className="usage-page__scroll">
        {/* 顶栏 */}
        <header className="usage-header">
          <div className="usage-header__left">
            <h2 className="usage-header__title">{t("usage.title")}</h2>
            <span className="usage-header__pricing">
              {availability.loaded ? t("usage.pricing_live") : t("usage.pricing_builtin")}
            </span>
          </div>
          <div className="usage-header__actions">
            <Tooltip content={t("model.check_availability_tooltip")} relationship="description">
              <Button
                appearance="secondary"
                icon={<Pulse20Regular />}
                disabled={availability.loading}
                onClick={() => runAsync(onSyncPricing())}
              >
                {t("usage.sync_pricing")}
              </Button>
            </Tooltip>
            <Button
              appearance="transparent"
              icon={<ArrowSync20Regular />}
              onClick={() => runAsync(loadUsage())}
            >
              {t("history.refresh")}
            </Button>
          </div>
        </header>

        {/* 总览 KPI 卡（纯积分统计，不含人民币估算） */}
        <section className="usage-kpis">
          <div className="usage-kpi">
            <span className="usage-kpi__label">{t("usage.kpi.total_credits")}</span>
            <span className="usage-kpi__value">{formatCredits(totalCredits)}</span>
            <span className="usage-kpi__sub">{t("usage.kpi.credits_only_note")}</span>
          </div>
          <div className="usage-kpi">
            <span className="usage-kpi__label">{t("usage.kpi.charged_runs")}</span>
            <span className="usage-kpi__value">{totalRuns}</span>
            <span className="usage-kpi__sub">
              {t("usage.kpi.charged_breakdown", { image: imageRuns, video: videoRuns })}
            </span>
          </div>
          <div className="usage-kpi">
            <span className="usage-kpi__label">{t("usage.kpi.range_credits")}</span>
            <span className="usage-kpi__value">{formatCredits(dailySeries.totalCredits)}</span>
            <span className="usage-kpi__sub">{t("usage.kpi.range_runs", { count: dailySeries.totalCount })}</span>
          </div>
          <div className="usage-kpi">
            <span className="usage-kpi__label">{t("usage.kpi.active_days", { year: heatmap.year })}</span>
            <span className="usage-kpi__value">{heatmap.activeDays}</span>
            <span className="usage-kpi__sub">
              {t("usage.kpi.peak_day", { credits: formatCredits(heatmap.maxDailyCredits) })}
            </span>
          </div>
        </section>

        {/* 全年贡献热力图 */}
        <YearlyHeatmapCard
          heatmap={heatmap}
          years={years}
          language={language}
          onYearChange={setSelectedYear}
        />

        {/* 扇形图时间段筛选条（默认全部历史记录；右侧日期控件常驻不引起高度跳动） */}
        <RangeFilterBar
          preset={piePreset}
          startDate={pieRange.start}
          endDate={pieRange.end}
          onPresetClick={(item) => {
            setPiePreset(item);
            const next = item === "all" ? allRecordsRange : resolvePresetRange(item);
            setPieCustomStart(next.start);
            setPieCustomEnd(next.end);
          }}
          onStartChange={(date) => {
            setPieCustomStart(date);
            setPieCustomEnd(pieRange.end);
            setPiePreset("custom");
          }}
          onEndChange={(date) => {
            setPieCustomStart(pieRange.start);
            setPieCustomEnd(date);
            setPiePreset("custom");
          }}
        />

        {/* 类型分布 & 模型分布扇形图 */}
        <section className="usage-grid-2">
          <DonutChartCard
            title={t("usage.pie.type_title")}
            slices={typeSlices}
            labelOf={typeLabel}
            colorOf={(key) => (key === "video" ? "#8B5CF6" : "var(--accent)")}
            emptyText={t("usage.empty")}
          />
          <DonutChartCard
            title={t("usage.pie.model_title")}
            slices={modelSlices}
            labelOf={modelLabel}
            colorOf={(key, idx) => modelColorMap.get(key) ?? colorForModel(key, idx)}
            emptyText={t("usage.empty")}
          />
        </section>

        {/* 时间段筛选条（驱动折线图 + 堆积柱状图；右侧日期控件常驻不引起高度跳动） */}
        <RangeFilterBar
          preset={preset}
          startDate={activeRange.start}
          endDate={activeRange.end}
          onPresetClick={(item) => {
            setPreset(item);
            const next = item === "all" ? allRecordsRange : resolvePresetRange(item);
            setCustomStart(next.start);
            setCustomEnd(next.end);
          }}
          onStartChange={(date) => {
            setCustomStart(date);
            setCustomEnd(activeRange.end);
            setPreset("custom");
          }}
          onEndChange={(date) => {
            setCustomStart(activeRange.start);
            setCustomEnd(date);
            setPreset("custom");
          }}
        />

        {/* 单天折线图 + 单天分模型堆积柱状图 */}
        <section className="usage-grid-2">
          <DailyLineChartCard series={dailySeries} />
          <StackedBarChartCard
            series={dailySeries}
            modelColorMap={modelColorMap}
            labelOf={modelLabel}
          />
        </section>

        <p className="usage-footnote">{t("usage.footnote")}</p>
      </div>
    </div>
  );
}
