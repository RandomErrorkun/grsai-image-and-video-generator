/** 当前编译版本（由 vite.config.ts 在编译期从 package.json 注入，无异步闪烁）。 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
