/**
 * 全局共享的模型可用性与定价状态仓（纯内存，不写磁盘/SQLite）。
 *
 * 一次请求 <grsai_site_url>/zh/models 会同时拿到图像、视频与对话全部模型状态与积分定价，
 * 图像页、视频页、漫画页、用量统计页共享同一份结果。
 * 内置并发防重入锁与冷却时间（默认 15 秒）；启动自动抓取或用户修改官网地址保存时可传 force: true 跳过冷却。
 */
import { useSyncExternalStore } from "react";
import type { HttpOutcome, HttpRequest } from "../core/api";
import { DEFAULT_CONFIG } from "../core/config";
import {
  buildModelsPageRequest,
  parseModelsAvailabilityHtml,
  type ModelAvailabilityEntry,
  type ModelAvailabilitySnapshot,
} from "../core/modelAvailability";
import { platform } from "../platform";
import { cfg } from "./config";

/** 手动检测冷却时间（毫秒），防止连续点击造成过多请求。 */
export const AVAILABILITY_COOLDOWN_MS = 15_000;

export type RefreshAvailabilityOutcome =
  | { kind: "ok"; total: number; available: number; unavailable: number }
  | { kind: "in_flight" }
  | { kind: "cooldown"; remainingSeconds: number }
  | { kind: "error"; message: string };

export interface RefreshOptions {
  /** 跳过冷却限制（用于应用启动自动抓取或用户刚修改官网地址后）。 */
  force?: boolean;
  /** 可选覆盖官网地址；不传时读取配置里的 grsai_site_url。 */
  siteUrl?: string;
}

export interface ModelAvailabilityStoreDeps {
  request(request: HttpRequest): Promise<HttpOutcome>;
  siteUrl?(): string;
  now?(): number;
  cooldownMs?: number;
}

export interface ModelAvailabilityStore {
  getSnapshot(): ModelAvailabilitySnapshot;
  subscribe(listener: () => void): () => void;
  refresh(options?: RefreshOptions): Promise<RefreshAvailabilityOutcome>;
}

export function createModelAvailabilityStore(deps: ModelAvailabilityStoreDeps): ModelAvailabilityStore {
  const now = () => (deps.now ?? Date.now)();
  const cooldownMs = deps.cooldownMs ?? AVAILABILITY_COOLDOWN_MS;
  const listeners = new Set<() => void>();

  let snapshot: ModelAvailabilitySnapshot = {
    loaded: false,
    loading: false,
    fetchedAt: null,
    models: new Map<string, ModelAvailabilityEntry>(),
  };
  let inFlight: Promise<RefreshAvailabilityOutcome> | null = null;
  let requestSeq = 0;

  const emit = (next: ModelAvailabilitySnapshot) => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  function refresh(options: RefreshOptions = {}): Promise<RefreshAvailabilityOutcome> {
    if (inFlight && !(options.force && options.siteUrl !== undefined)) {
      return Promise.resolve({ kind: "in_flight" });
    }
    if (!options.force && snapshot.fetchedAt !== null) {
      const elapsed = now() - snapshot.fetchedAt;
      if (elapsed < cooldownMs) {
        return Promise.resolve({
          kind: "cooldown",
          remainingSeconds: Math.max(1, Math.ceil((cooldownMs - elapsed) / 1000)),
        });
      }
    }

    const seq = ++requestSeq;
    const siteUrl = options.siteUrl ?? deps.siteUrl?.();
    emit({ ...snapshot, loading: true });
    const run = (async (): Promise<RefreshAvailabilityOutcome> => {
      try {
        const outcome = await deps.request(buildModelsPageRequest(siteUrl));
        if (seq !== requestSeq) return { kind: "in_flight" };
        if (outcome.outcome !== "responded") {
          emit({ ...snapshot, loading: false });
          return { kind: "error", message: outcome.message };
        }
        if (outcome.status < 200 || outcome.status >= 300) {
          emit({ ...snapshot, loading: false });
          return { kind: "error", message: `HTTP ${outcome.status}` };
        }
        const parsed = parseModelsAvailabilityHtml(outcome.body);
        if (!parsed) {
          emit({ ...snapshot, loading: false });
          return { kind: "error", message: "Could not parse model list from Grsai page." };
        }
        let available = 0;
        let unavailable = 0;
        for (const entry of parsed.values()) {
          if (entry.status === "available") available += 1;
          else unavailable += 1;
        }
        emit({
          loaded: true,
          loading: false,
          fetchedAt: now(),
          models: parsed,
        });
        return { kind: "ok", total: parsed.size, available, unavailable };
      } catch (error) {
        if (seq !== requestSeq) return { kind: "in_flight" };
        emit({ ...snapshot, loading: false });
        return { kind: "error", message: error instanceof Error ? error.message : String(error) };
      } finally {
        if (seq === requestSeq) inFlight = null;
      }
    })();

    inFlight = run;
    return run;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
  };
}

export const modelAvailability = createModelAvailabilityStore({
  request: (request) => platform.http.request(request),
  siteUrl: () => String(cfg.get("grsai_site_url", DEFAULT_CONFIG.grsai_site_url) || DEFAULT_CONFIG.grsai_site_url),
});

export function useModelAvailability(): ModelAvailabilitySnapshot {
  return useSyncExternalStore(modelAvailability.subscribe, modelAvailability.getSnapshot, modelAvailability.getSnapshot);
}
