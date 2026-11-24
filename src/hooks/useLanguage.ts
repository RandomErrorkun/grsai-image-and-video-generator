import { useSyncExternalStore } from "react";
import { getLanguage, subscribeLanguage, tr, type Language } from "../i18n";

/** 订阅当前界面语言；组件借它在切换语言时重渲染。 */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}

/** 取 tr()，并订阅语言变化。 */
export function useTr(): typeof tr {
  useLanguage();
  return tr;
}
