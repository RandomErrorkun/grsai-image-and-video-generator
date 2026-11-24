import { useSyncExternalStore } from "react";
import type { AppConfig, ConfigValue } from "../core/config";
import { cfg } from "../state/config";

type ConfigValueOf<K extends string> = K extends keyof AppConfig ? AppConfig[K] : ConfigValue;

/** 订阅一个配置键；cfg.set 改到它时组件会重渲染。 */
export function useConfigValue<K extends string>(key: K, fallback: ConfigValueOf<K>): ConfigValueOf<K> {
  return useSyncExternalStore(cfg.subscribe, () => cfg.get(key, fallback));
}
