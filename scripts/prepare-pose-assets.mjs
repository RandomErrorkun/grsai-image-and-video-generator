/**
 * 预处理 3D 姿势工坊与内嵌字体所需的静态资产：
 * 1. 将 ComfyUI-Fisher-Pose 的 MakeHuman 二进制包用 Brotli 11 级无损预压到 src-tauri/assets/pose_studio_makehuman.v2.bin.br（~2.89 MB）
 * 2. 复制 29 张常用姿势缩略图到 src/assets/pose-thumbs/
 * 3. 复制 JetBrainsMapleMono-Regular.ttf 到 src/assets/fonts/JetBrainsMapleMono-Regular.ttf
 * 4. 复制 color_scheme.json 到 src/core/posePalettes.json
 */
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

// 1. MakeHuman Brotli 预压
const rawBinPath = join(root, "ComfyUI-Fisher-Pose", "web", "vnccs", "assets", "pose_studio_makehuman.v2.bin");
const brOutPath = join(root, "src-tauri", "assets", "pose_studio_makehuman.v2.bin.br");
ensureDir(dirname(brOutPath));

if (existsSync(rawBinPath)) {
  if (!existsSync(brOutPath)) {
    console.log("[prepare-pose-assets] Compressing MakeHuman binary with Brotli-11...");
    const raw = readFileSync(rawBinPath);
    const compressed = brotliCompressSync(raw, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_GENERIC,
      },
    });
    const roundtrip = brotliDecompressSync(compressed);
    if (!raw.equals(roundtrip)) {
      throw new Error("Brotli lossless verification failed for pose_studio_makehuman.v2.bin");
    }
    writeFileSync(brOutPath, compressed);
    console.log(
      `[prepare-pose-assets] Saved ${brOutPath} (${(raw.length / 1048576).toFixed(2)} MB -> ${(compressed.length / 1048576).toFixed(2)} MB)`,
    );
  } else {
    console.log("[prepare-pose-assets] Brotli MakeHuman asset already exists, skipping compression.");
  }
} else if (!existsSync(brOutPath)) {
  throw new Error(`Missing source MakeHuman binary: ${rawBinPath}`);
}

// 2. 29 张常用姿势缩略图
const thumbsSrc = join(root, "ComfyUI-Fisher-Pose", "web", "editor", "common-poses");
const thumbsDst = join(root, "src", "assets", "pose-thumbs");
ensureDir(thumbsDst);
if (existsSync(thumbsSrc)) {
  let count = 0;
  for (const name of readdirSync(thumbsSrc)) {
    if (!name.endsWith(".webp")) continue;
    copyFileSync(join(thumbsSrc, name), join(thumbsDst, name));
    count += 1;
  }
  console.log(`[prepare-pose-assets] Copied ${count} common pose thumbnails.`);
}

// 3. JetBrainsMapleMono-Regular.ttf
const fontSrc = join(root, "fonts", "JetBrainsMapleMono", "JetBrainsMapleMono-Regular.ttf");
const fontDst = join(root, "src", "assets", "fonts", "JetBrainsMapleMono-Regular.ttf");
ensureDir(dirname(fontDst));
if (existsSync(fontSrc)) {
  copyFileSync(fontSrc, fontDst);
  console.log(`[prepare-pose-assets] Copied JetBrainsMapleMono-Regular.ttf.`);
} else if (!existsSync(fontDst)) {
  throw new Error(`Missing font source: ${fontSrc}`);
}

// 4. color_scheme.json -> src/core/posePalettes.json
const paletteSrc = join(root, "color_scheme.json");
const paletteDst = join(root, "src", "core", "posePalettes.json");
if (existsSync(paletteSrc)) {
  copyFileSync(paletteSrc, paletteDst);
  console.log(`[prepare-pose-assets] Copied color_scheme.json -> src/core/posePalettes.json.`);
} else if (!existsSync(paletteDst)) {
  throw new Error(`Missing palette source: ${paletteSrc}`);
}
