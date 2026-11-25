import { createConfigStore, DEFAULT_CONFIG } from "../core/config";
import { platform } from "../platform";

/** 全局配置存储，对应源项目的 core.config.cfg（cfg.get / cfg.set）。 */
export const cfg = createConfigStore(platform.configStorage);

/** 启动时先解析数据目录、读完配置、放行输出目录，再渲染界面，主题和语言才不会先闪一下默认值。 */
export async function loadConfig(): Promise<void> {
  await platform.init();
  await cfg.load();
  const folder = String(cfg.get("output_folder", DEFAULT_CONFIG.output_folder) || DEFAULT_CONFIG.output_folder);
  const resolved = platform.paths.absolute(folder, platform.dataDir);
  await platform.media.allow([resolved], true).catch(() => {});
}
