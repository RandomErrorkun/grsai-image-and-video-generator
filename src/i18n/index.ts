/**
 * 界面文案（对应 core/i18n.py）。
 *
 * 键名与源项目一致；en.json / zh.json 里来自源项目的键是原样导出的，
 * 后面追加的键是重写版外壳自己的（导航提示、窗口按钮、主题选项）。
 */
import en from "./en.json";
import zh from "./zh.json";

export type Language = "en" | "zh";

/** 与源项目的 SUPPORTED_LANGUAGES 顺序一致。 */
export const SUPPORTED_LANGUAGES: readonly Language[] = ["en", "zh"];

export type Kwargs = Record<string, unknown>;

type TranslationTable = Record<string, string>;

const TRANSLATIONS: Record<Language, TranslationTable> = {
  en: en as TranslationTable,
  zh: zh as TranslationTable,
};

/** 对应 normalize_language：以 zh 开头都算中文，其余一律英文。 */
export function normalizeLanguage(language: unknown): Language {
  const value = typeof language === "string" ? language.toLowerCase() : "";
  return value.startsWith("zh") ? "zh" : "en";
}

/** 模拟 Python 的 str()，文案里的占位符都按它转成字符串。 */
function pythonStr(value: unknown): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null || value === undefined) return "None";
  return String(value);
}

/**
 * 模拟 str.format(**kwargs)。源项目在 format 抛错时退回原文，
 * 所以这里遇到解析不了的情况（占位符缺参数、花括号不配对）返回 null。
 */
function formatTemplate(text: string, kwargs: Kwargs): string | null {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" && text[index + 1] === "{") {
      result += "{";
      index += 1;
    } else if (char === "}" && text[index + 1] === "}") {
      result += "}";
      index += 1;
    } else if (char === "}") {
      return null;
    } else if (char === "{") {
      const end = text.indexOf("}", index + 1);
      if (end < 0) return null;
      const name = text.slice(index + 1, end);
      if (name === "" || !Object.prototype.hasOwnProperty.call(kwargs, name)) return null;
      result += pythonStr(kwargs[name]);
      index = end;
    } else {
      result += char;
    }
  }
  return result;
}

/** 按指定语言取文案（对应 tr 的查表部分）：本语言没有就退回英文，再没有就返回键名。 */
export function translate(language: Language, key: string, kwargs?: Kwargs): string {
  const text = TRANSLATIONS[language]?.[key] ?? TRANSLATIONS.en[key] ?? key;
  if (!kwargs || Object.keys(kwargs).length === 0) return text;
  return formatTemplate(text, kwargs) ?? text;
}

let currentLanguage: Language = "en";
const languageListeners = new Set<() => void>();

/** 当前界面语言（对应 get_language）。 */
export function getLanguage(): Language {
  return currentLanguage;
}

export function setLanguage(language: Language): void {
  if (language === currentLanguage) return;
  currentLanguage = language;
  for (const listener of [...languageListeners]) listener();
}

export function subscribeLanguage(listener: () => void): () => void {
  languageListeners.add(listener);
  return () => {
    languageListeners.delete(listener);
  };
}

/** 按当前界面语言取文案（对应 tr）。 */
export function tr(key: string, kwargs?: Kwargs): string {
  return translate(currentLanguage, key, kwargs);
}

/** 语言下拉框的选项（对应 language_items）：代码和显示名。 */
export function languageItems(): Array<{ code: Language; label: string }> {
  return SUPPORTED_LANGUAGES.map((code) => ({
    code,
    label: tr(`settings.language.${code}`),
  }));
}
