/**
 * 应用主题。强调色可以由用户在设置里改，色阶在运行时按所选颜色推导。
 * 量到的源项目默认值是 #0078D4（main.py 里的 setThemeColor）。
 */
import { createDarkTheme, createLightTheme, type BrandVariants, type Theme } from "@fluentui/react-components";

type BrandStep = keyof BrandVariants;

/** 源项目写死的强调色，也是默认值。 */
export const DEFAULT_ACCENT_COLOR = "#0078D4";

/** 设置页调色板里备选的主题色，从亮到暗排了一组常用色。 */
export const ACCENT_PALETTE: readonly string[] = [
  "#0078D4", "#0063B1", "#0099BC", "#00B294",
  "#107C10", "#CA5010", "#D13438", "#E81123",
  "#C30052", "#9A0089", "#881798", "#744DA9",
  "#8764B8", "#5C2E91", "#3B3A39", "#767676",
];

/** Fluent UI 内置的蓝色阶（@fluentui/tokens 的 brandWeb）。自定义色阶都由它推出来。 */
const WEB_BRAND: BrandVariants = {
  10: "#061724",
  20: "#082338",
  30: "#0a2e4a",
  40: "#0c3b5e",
  50: "#0e4775",
  60: "#0f548c",
  70: "#115ea3",
  80: "#0f6cbd",
  90: "#2886de",
  100: "#479ef5",
  110: "#62abf5",
  120: "#77b7f7",
  130: "#96c6fa",
  140: "#b4d6fa",
  150: "#cfe4fa",
  160: "#ebf3fc",
};
const BRAND_STEPS = Object.keys(WEB_BRAND).map(Number) as BrandStep[];

/** 源项目的界面字体（qfluentwidgets 的 fontFamilies）。 */
const fontFamily = '"Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

/** 只认 #RGB 或 #RRGGBB，统一成小写的 #RRGGBB；别的值返回 null。 */
export function normalizeAccentColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? [...match[1]].map((char) => char + char).join("") : match[1];
  return `#${hex.toLowerCase()}`;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function hexToHsl(hex: string): Hsl {
  const channel = (offset: number) => parseInt(hex.slice(offset, offset + 2), 16) / 255;
  const r = channel(1);
  const g = channel(3);
  const b = channel(5);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  const to = (value: number) => Math.round((value + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * 由一个强调色推出 16 级色阶：80 档就是强调色本身，
 * 其余各档沿用内置蓝色阶的明度曲线，色相和饱和度向强调色靠拢。
 */
export function createBrandVariants(accent: string): BrandVariants {
  const anchor = hexToHsl(WEB_BRAND[80]);
  const target = hexToHsl(accent);
  const hueShift = target.h - anchor.h;
  const saturationScale = anchor.s === 0 ? 1 : target.s / anchor.s;
  const brand = {} as Record<BrandStep, string>;
  for (const step of BRAND_STEPS) {
    if (step === 80) {
      brand[step] = accent;
      continue;
    }
    const source = hexToHsl(WEB_BRAND[step]);
    brand[step] = hslToHex(source.h + hueShift, Math.min(1, source.s * saturationScale), source.l);
  }
  return brand;
}

export interface AppThemes {
  light: Theme;
  dark: Theme;
}

function withAppFonts(theme: Theme): Theme {
  return { ...theme, fontFamilyBase: fontFamily, fontFamilyNumeric: fontFamily };
}

const cache = new Map<string, AppThemes>();

/** 取某个强调色下的亮暗两套主题；同样的颜色只算一次。 */
export function themesFor(accent: string): AppThemes {
  const cached = cache.get(accent);
  if (cached) return cached;
  const brand = createBrandVariants(accent);
  const themes = {
    light: withAppFonts(createLightTheme(brand)),
    dark: withAppFonts(createDarkTheme(brand)),
  };
  cache.set(accent, themes);
  return themes;
}
