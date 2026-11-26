/**
 * 编译不带调试信息的单文件 Release 可执行文件，并自动按版本号重命名为：
 *   src-tauri/target/release/grsai-image-and-video-generator_v<x.y.z>.exe
 *
 * 构建前会先校验 package.json、src-tauri/tauri.conf.json 与 src-tauri/Cargo.toml
 * 三处版本号完全一致，避免产物名与 PE 文件版本或界面显示版本不一致。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tauriConf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
const cargoMatch = /^version\s*=\s*"([^"]+)"/m.exec(cargoToml);

const version = String(pkg.version ?? "").trim();
const tauriVersion = String(tauriConf.version ?? "").trim();
const cargoVersion = cargoMatch ? cargoMatch[1].trim() : "";

if (!version) {
  console.error("Missing version in package.json");
  process.exit(1);
}
if (version !== tauriVersion || version !== cargoVersion) {
  console.error(
    `Version mismatch: package.json=${version}, tauri.conf.json=${tauriVersion}, Cargo.toml=${cargoVersion}`,
  );
  process.exit(1);
}

const tauriCli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const result = spawnSync(process.execPath, [tauriCli, "build", "--no-bundle"], {
  cwd: root,
  stdio: "inherit",
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const releaseDir = join(root, "src-tauri", "target", "release");
const baseName = "grsai-image-and-video-generator";
const rawExe = join(releaseDir, `${baseName}.exe`);
const versionedExe = join(releaseDir, `${baseName}_v${version}.exe`);

if (!existsSync(rawExe)) {
  console.error(`Expected build output not found: ${rawExe}`);
  process.exit(1);
}
if (existsSync(versionedExe)) {
  rmSync(versionedExe, { force: true });
}
renameSync(rawExe, versionedExe);

const sizeMB = (statSync(versionedExe).size / (1024 * 1024)).toFixed(2);
console.log(`\nVersioned release executable ready: ${versionedExe} (${sizeMB} MB)`);
