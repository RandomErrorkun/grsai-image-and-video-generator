/**
 * 页面上方的分段条（对应源项目的 SegmentedWidget）。
 *
 * 两种用法：给了 onChange 就是选项卡，比如生成页的 Banana 和 GPT Image；
 * 不给就是单行的标题条，比如各页的 Task List，只显示文字和下面那一小段强调色。
 */
import { useTr } from "../hooks/useLanguage";
import "./SegmentedHeader.css";

export interface SegmentedItem {
  key: string;
  label: string;
}

interface SegmentedHeaderProps {
  items: readonly SegmentedItem[];
  /** 选中的那一项；不给就选第一项。 */
  value?: string;
  /** 给了就是可点的选项卡。 */
  onChange?: (key: string) => void;
  className?: string;
  /** 无障碍用的名字，不给就用选中项的文字。 */
  "aria-label"?: string;
}

export function SegmentedHeader({ items, value, onChange, className, "aria-label": ariaLabel }: SegmentedHeaderProps) {
  const t = useTr();
  const selected = value ?? items[0]?.key;
  const interactive = onChange !== undefined;

  return (
    <div
      className={className ? `segmented ${className}` : "segmented"}
      role={interactive ? "tablist" : undefined}
      aria-label={ariaLabel}
    >
      {items.map((item) => {
        const active = item.key === selected;
        const text = t(item.label);
        const state = active ? "segmented__item segmented__item--selected" : "segmented__item";
        return interactive ? (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active}
            className={state}
            onClick={() => onChange(item.key)}
          >
            <span className="segmented__label">{text}</span>
            {active ? <span className="segmented__indicator" /> : null}
          </button>
        ) : (
          <div key={item.key} className={state}>
            <span className="segmented__label">{text}</span>
            {active ? <span className="segmented__indicator" /> : null}
          </div>
        );
      })}
    </div>
  );
}
