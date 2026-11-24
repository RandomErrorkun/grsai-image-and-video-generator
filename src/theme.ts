import {
  createDarkTheme,
  createLightTheme,
  type BrandVariants,
  type Theme,
} from "@fluentui/react-components";

/** 源项目的强调色（main.py 里的 setThemeColor）。 */
export const ACCENT_COLOR = "#0078D4";

/**
 * 强调色的 16 级色阶，80 档就是强调色本身。
 * 其余各档由 Fluent UI 内置的蓝色阶（brandWeb）按强调色的色相和饱和度推得，明度曲线不变。
 */
const BRAND: BrandVariants = {
  10: "#031827",
  20: "#04253c",
  30: "#043150",
  40: "#053f65",
  50: "#054c7e",
  60: "#045a97",
  70: "#0464b0",
  80: "#0078d4",
  90: "#188dee",
  100: "#3da4ff",
  110: "#58b0ff",
  120: "#6fbcff",
  130: "#91c9ff",
  140: "#afd8ff",
  150: "#cbe6fe",
  160: "#eaf4fd",
};

/** 源项目的界面字体（qfluentwidgets 的 fontFamilies）。 */
const fontFamily = '"Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

function withAppFonts(theme: Theme): Theme {
  return { ...theme, fontFamilyBase: fontFamily, fontFamilyNumeric: fontFamily };
}

/** Fluent UI 默认品牌色是 #0F6CBD，这里换成源项目的强调色。 */
export const lightTheme: Theme = withAppFonts(createLightTheme(BRAND));

export const darkTheme: Theme = withAppFonts(createDarkTheme(BRAND));
