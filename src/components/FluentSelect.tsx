/**
 * 全应用统一的 Fluent 下拉选择组件：
 * - 基于 Fluent UI v9 `<Dropdown>` + `<Option>`，选中项统一显示左侧打勾（✓），不再出现原生 `<select>` 的灰底选中态；
 * - 定位策略强制仅向下展开（`position: "below"` + `pinned: true`）并按窗口剩余高度自适应收缩出内部滚动条（`autoSize: "height"`），
 *   永不跳到按钮右侧/上方，也绝不超出窗口底边。
 */
import { Dropdown, Option } from "@fluentui/react-components";
import "./FluentSelect.css";

export const DOWNWARD_POSITIONING = {
  position: "below" as const,
  align: "start" as const,
  pinned: true,
  autoSize: "height" as const,
  overflowBoundaryPadding: 8,
};

export interface SelectOption {
  value: string;
  label: string;
}

export interface FluentSelectProps {
  value: string;
  options: readonly (string | SelectOption)[];
  ariaLabel: string;
  disabled?: boolean;
  size?: "small" | "medium" | "large";
  className?: string;
  placeholder?: string;
  onChange(value: string): void;
}

export function FluentSelect({
  value,
  options,
  ariaLabel,
  disabled = false,
  size,
  className,
  placeholder,
  onChange,
}: FluentSelectProps) {
  const normalized: SelectOption[] = options.map((item) =>
    typeof item === "string" ? { value: item, label: item } : item,
  );
  const current = normalized.find((item) => item.value === value);
  const displayValue = current ? current.label : (value || placeholder || "");

  return (
    <Dropdown
      className={className ? `fluent-select ${className}` : "fluent-select"}
      listbox={{ className: "fluent-select__listbox" }}
      positioning={DOWNWARD_POSITIONING}
      size={size}
      value={displayValue}
      placeholder={placeholder}
      selectedOptions={current ? [current.value] : []}
      aria-label={ariaLabel}
      disabled={disabled}
      onOptionSelect={(_event, data) => {
        if (data.optionValue !== undefined) onChange(data.optionValue);
      }}
    >
      {normalized.map((item) => (
        <Option key={item.value} value={item.value} text={item.label}>
          {item.label}
        </Option>
      ))}
    </Dropdown>
  );
}
