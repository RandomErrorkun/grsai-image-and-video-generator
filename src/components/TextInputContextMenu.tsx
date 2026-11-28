/**
 * 全应用统一的文本输入框右键编辑菜单（剪切 / 复制 / 粘贴 / 全选 / 清空）。
 *
 * 自动覆盖所有 <textarea> 与文本类 <input>（包含提示词框、设置页、姿势页输入框等），
 * 在全局禁用 WebView2 原生右键菜单的前提下，提供干净的原生感文字编辑操作。
 */
import { useEffect, useState } from "react";
import { useTr } from "../hooks/useLanguage";
import { platform } from "../platform";
import { runAsync } from "../platform/async";
import "./TextInputContextMenu.css";

type EditableElement = HTMLInputElement | HTMLTextAreaElement;

interface TextMenuState {
  x: number;
  y: number;
  target: EditableElement;
  hasSelection: boolean;
  hasValue: boolean;
  isPassword: boolean;
  isReadOnly: boolean;
}

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "radio",
  "submit",
  "reset",
  "file",
  "range",
  "color",
  "image",
  "hidden",
]);

function resolveEditableElement(node: EventTarget | null): EditableElement | null {
  if (!(node instanceof HTMLElement)) return null;
  if (node instanceof HTMLTextAreaElement) {
    return node.disabled ? null : node;
  }
  if (node instanceof HTMLInputElement) {
    if (node.disabled) return null;
    if (NON_TEXT_INPUT_TYPES.has((node.type || "text").toLowerCase())) return null;
    return node;
  }
  return null;
}

/** 通过原生原型 setter 更新受控 input/textarea 值并派发 input 事件，确保 React 状态同步更新。 */
function setNativeInputValue(element: EditableElement, nextValue: string, caretPos?: number): void {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  descriptor?.set?.call(element, nextValue);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.focus();
  if (typeof caretPos === "number") {
    try {
      const clamped = Math.max(0, Math.min(nextValue.length, caretPos));
      element.setSelectionRange(clamped, clamped);
    } catch {
      // 部分 input type（如 number）不支持 setSelectionRange，忽略即可
    }
  }
}

async function readClipboardText(): Promise<string> {
  try {
    const snap = await platform.clipboard.read();
    if (snap.kind === "text") return snap.text;
  } catch {
    // 回退浏览器剪贴板 API
  }
  try {
    if (navigator.clipboard?.readText) {
      return await navigator.clipboard.readText();
    }
  } catch {
    // 无剪贴板文本权限
  }
  return "";
}

async function writeClipboardText(text: string): Promise<void> {
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // 回退 execCommand
  }
  try {
    document.execCommand("copy");
  } catch {
    // ignore
  }
}

export function TextInputContextMenu() {
  const t = useTr();
  const [menu, setMenu] = useState<TextMenuState | null>(null);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const target = resolveEditableElement(event.target);
      if (!target) {
        setMenu(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      let hasSelection = false;
      try {
        const start = target.selectionStart ?? 0;
        const end = target.selectionEnd ?? 0;
        hasSelection = end > start;
      } catch {
        hasSelection = false;
      }

      const menuW = 160;
      const menuH = 190;
      const x = Math.min(event.clientX, Math.max(8, window.innerWidth - menuW));
      const y = Math.min(event.clientY, Math.max(8, window.innerHeight - menuH));

      setMenu({
        x,
        y,
        target,
        hasSelection,
        hasValue: target.value.length > 0,
        isPassword: target instanceof HTMLInputElement && target.type.toLowerCase() === "password",
        isReadOnly: target.readOnly,
      });
    };

    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  if (!menu) return null;

  const { target, hasSelection, hasValue, isPassword, isReadOnly } = menu;

  const getSelectionRange = (): [number, number] => {
    try {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      return [start, end];
    } catch {
      return [0, target.value.length];
    }
  };

  const handleCut = async () => {
    setMenu(null);
    if (isReadOnly || isPassword || !hasSelection) return;
    const [start, end] = getSelectionRange();
    const selected = target.value.slice(start, end);
    if (!selected) return;
    await writeClipboardText(selected);
    const next = target.value.slice(0, start) + target.value.slice(end);
    setNativeInputValue(target, next, start);
  };

  const handleCopy = async () => {
    setMenu(null);
    if (isPassword || !hasSelection) return;
    const [start, end] = getSelectionRange();
    const selected = target.value.slice(start, end);
    if (selected) await writeClipboardText(selected);
  };

  const handlePaste = async () => {
    setMenu(null);
    if (isReadOnly) return;
    const pasted = await readClipboardText();
    if (!pasted) return;
    const [start, end] = getSelectionRange();
    const next = target.value.slice(0, start) + pasted + target.value.slice(end);
    setNativeInputValue(target, next, start + pasted.length);
  };

  const handleSelectAll = () => {
    setMenu(null);
    target.focus();
    target.select();
  };

  const handleClear = () => {
    setMenu(null);
    if (isReadOnly || !hasValue) return;
    setNativeInputValue(target, "", 0);
  };

  return (
    <div
      className="text-ctx-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        disabled={isReadOnly || isPassword || !hasSelection}
        onClick={() => runAsync(handleCut())}
      >
        <span>{t("text_menu.cut")}</span>
        <kbd>Ctrl+X</kbd>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={isPassword || !hasSelection}
        onClick={() => runAsync(handleCopy())}
      >
        <span>{t("text_menu.copy")}</span>
        <kbd>Ctrl+C</kbd>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={isReadOnly}
        onClick={() => runAsync(handlePaste())}
      >
        <span>{t("text_menu.paste")}</span>
        <kbd>Ctrl+V</kbd>
      </button>
      <div className="text-ctx-menu__sep" />
      <button
        type="button"
        role="menuitem"
        disabled={!hasValue}
        onClick={handleSelectAll}
      >
        <span>{t("text_menu.select_all")}</span>
        <kbd>Ctrl+A</kbd>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={isReadOnly || !hasValue}
        onClick={handleClear}
      >
        <span>{t("text_menu.clear")}</span>
      </button>
    </div>
  );
}
