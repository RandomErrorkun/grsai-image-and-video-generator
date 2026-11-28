import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";
import { Button, Tooltip } from "@fluentui/react-components";
import { ClipboardPaste20Regular, Delete20Regular, Edit20Regular } from "@fluentui/react-icons";
import { upsertPoseAnchorInPrompt } from "../core/posePrompt";
import { useConfigValue } from "../hooks/useConfigValue";
import { useTr } from "../hooks/useLanguage";
import { platform } from "../platform";
import { runAsync } from "../platform/async";
import { notice } from "./Notice";
import "./PromptWidget.css";

/** 页面通过 ref 拿到的几个动作，对应源项目 PromptWidget 上的同名方法。 */
export interface PromptWidgetHandle {
  /** 去掉首尾空白后的提示词。 */
  getPrompt(): string;
  setPrompt(text: string): void;
  /** 智能写入或原地替换姿势参考身份锚定块（保留用户其余提示词）。 */
  upsertPoseAnchorBlock(block: string): void;
  pasteFromClipboard(): Promise<void>;
  clear(): void;
  focus(): void;
}

interface PromptWidgetProps {
  ref?: Ref<PromptWidgetHandle>;
  /** 高度由页面决定，组件自己只管撑满。 */
  className?: string;
}

/** 一点按 96 DPI 换算是 4/3 像素；源项目的字号是点。 */
const PT_TO_PX = 96 / 72;

function quoteFamily(family: string): string {
  const names = family
    .split(",")
    .map((name) => name.trim().replace(/"/g, ""))
    .filter(Boolean);
  return names.length ? `${names.map((name) => `"${name}"`).join(", ")}, sans-serif` : "inherit";
}

/** 提示词输入框（对应 ui/components/prompt_widget.py）。 */
export default function PromptWidget({ ref, className }: PromptWidgetProps) {
  const t = useTr();
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 光标位置：插完文本、重排格式之后要把光标放回去
  const caretRef = useRef<number | null>(null);

  const formatEnabled = useConfigValue("text_format_enabled", true);
  const fontSize = useConfigValue("text_font_size", 9);
  const fontFamily = useConfigValue("text_font_family", "JetBrainsMapleMono");
  const autoWrap = useConfigValue("text_auto_wrap", true);

  const formatStyle: CSSProperties | undefined = formatEnabled
    ? { fontFamily: quoteFamily(fontFamily), fontSize: `${Number((fontSize * PT_TO_PX).toFixed(2))}px` }
    : undefined;

  const pasteFromClipboard = useCallback(async () => {
    const snapshot = await platform.clipboard.read();
    if (snapshot.kind !== "text" || !snapshot.text) return;
    const input = inputRef.current;
    const start = input?.selectionStart ?? text.length;
    const end = input?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + snapshot.text + text.slice(end));
    caretRef.current = start + snapshot.text.length;
    notice("success", t("common.pasted"), t("prompt.msg.pasted"));
  }, [text, t]);

  const normalizePromptFormat = useCallback(() => {
    // 输入框本来就是纯文本，这里只把光标放回原处
    caretRef.current = inputRef.current?.selectionStart ?? text.length;
    notice("success", t("common.formatted"), t("prompt.msg.formatted"));
  }, [text.length, t]);

  const clearPrompt = useCallback(() => {
    setText("");
    notice("success", t("common.cleared"), t("prompt.msg.cleared"));
  }, [t]);

  useImperativeHandle(ref, () => ({
    getPrompt: () => text.trim(),
    setPrompt: (next: string) => {
      caretRef.current = next.length;
      setText(next);
    },
    upsertPoseAnchorBlock: (block: string) => {
      setText((prev) => {
        const next = upsertPoseAnchorInPrompt(prev, block);
        caretRef.current = next.length;
        return next;
      });
    },
    pasteFromClipboard,
    clear: clearPrompt,
    focus: () => inputRef.current?.focus(),
  }), [text, pasteFromClipboard, clearPrompt]);

  // 文本变了之后光标会跳到末尾，按记下的位置放回去，赶在绘制之前
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || caretRef.current === null) return;
    const position = Math.min(caretRef.current, text.length);
    input.setSelectionRange(position, position);
    caretRef.current = null;
  }, [text]);

  return (
    <div className={className ? `prompt-widget ${className}` : "prompt-widget"}>
      <div className="prompt-widget__header">
        <span className="prompt-widget__title">{t("prompt.title")}</span>
        <div className="prompt-widget__tools">
          <Tooltip content={t("prompt.tooltip.paste")} relationship="label">
            <Button
              appearance="transparent"
              size="small"
              icon={<ClipboardPaste20Regular />}
              aria-label={t("prompt.tooltip.paste")}
              onClick={() => runAsync(pasteFromClipboard())}
            />
          </Tooltip>
          <Tooltip content={t("prompt.tooltip.format")} relationship="label">
            <Button
              appearance="transparent"
              size="small"
              icon={<Edit20Regular />}
              aria-label={t("prompt.tooltip.format")}
              onClick={normalizePromptFormat}
            />
          </Tooltip>
          <Tooltip content={t("prompt.tooltip.clear")} relationship="label">
            <Button
              appearance="transparent"
              size="small"
              icon={<Delete20Regular />}
              aria-label={t("prompt.tooltip.clear")}
              onClick={clearPrompt}
            />
          </Tooltip>
        </div>
      </div>
      <textarea
        ref={inputRef}
        className="prompt-widget__input"
        style={formatStyle}
        value={text}
        wrap={autoWrap ? "soft" : "off"}
        spellCheck={false}
        placeholder={t("prompt.placeholder")}
        aria-label={t("prompt.title")}
        onChange={(event) => setText(event.target.value)}
      />
    </div>
  );
}
