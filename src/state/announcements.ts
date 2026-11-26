/**
 * Grsai 官方公告共享内存仓，以及一键同步官网数据（模型 + 公告）的统一入口。
 */
import { useSyncExternalStore } from "react";
import type { HttpOutcome, HttpRequest } from "../core/api";
import { DEFAULT_CONFIG } from "../core/config";
import {
  buildAnnouncementsPageRequest,
  parseAnnouncementsHtml,
  type OfficialAnnouncement,
} from "../core/modelAvailability";
import { normalizeLanguage } from "../i18n";
import { platform } from "../platform";
import { cfg } from "./config";
import { modelAvailability, type RefreshAvailabilityOutcome } from "./modelAvailability";

export const ANNOUNCEMENTS_COOLDOWN_MS = 15_000;

export interface AnnouncementsSnapshot {
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly fetchedAt: number | null;
  readonly error: string | null;
  readonly items: readonly OfficialAnnouncement[];
}

export type RefreshAnnouncementsOutcome =
  | { kind: "ok"; count: number }
  | { kind: "in_flight" }
  | { kind: "cooldown"; remainingSeconds: number }
  | { kind: "error"; message: string };

export interface AnnouncementsStoreDeps {
  request(request: HttpRequest): Promise<HttpOutcome>;
  siteUrl?(): string;
  language?(): "en" | "zh";
  now?(): number;
  cooldownMs?: number;
}

export interface AnnouncementsStore {
  getSnapshot(): AnnouncementsSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(options?: { force?: boolean; siteUrl?: string; language?: "en" | "zh" }): Promise<RefreshAnnouncementsOutcome>;
}

export function createAnnouncementsStore(deps: AnnouncementsStoreDeps): AnnouncementsStore {
  const now = () => (deps.now ?? Date.now)();
  const cooldownMs = deps.cooldownMs ?? ANNOUNCEMENTS_COOLDOWN_MS;
  const listeners = new Set<() => void>();

  let snapshot: AnnouncementsSnapshot = {
    loaded: false,
    loading: false,
    fetchedAt: null,
    error: null,
    items: [],
  };
  let inFlight: Promise<RefreshAnnouncementsOutcome> | null = null;
  let requestSeq = 0;

  const emit = (next: AnnouncementsSnapshot) => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  function refresh(
    options: { force?: boolean; siteUrl?: string; language?: "en" | "zh" } = {},
  ): Promise<RefreshAnnouncementsOutcome> {
    if (inFlight && !(options.force && (options.siteUrl !== undefined || options.language !== undefined))) {
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
    const language = options.language ?? deps.language?.() ?? "zh";
    emit({ ...snapshot, loading: true, error: null });

    const run = (async (): Promise<RefreshAnnouncementsOutcome> => {
      try {
        const outcome = await deps.request(buildAnnouncementsPageRequest(siteUrl, language));
        if (seq !== requestSeq) return { kind: "in_flight" };
        if (outcome.outcome !== "responded") {
          emit({ ...snapshot, loading: false, error: outcome.message });
          return { kind: "error", message: outcome.message };
        }
        if (outcome.status < 200 || outcome.status >= 300) {
          const message = `HTTP ${outcome.status}`;
          emit({ ...snapshot, loading: false, error: message });
          return { kind: "error", message };
        }
        const parsed = parseAnnouncementsHtml(outcome.body, siteUrl);
        if (!parsed) {
          const message = "Could not parse announcements from Grsai page.";
          emit({ ...snapshot, loading: false, error: message });
          return { kind: "error", message };
        }
        emit({
          loaded: true,
          loading: false,
          fetchedAt: now(),
          error: null,
          items: parsed,
        });
        return { kind: "ok", count: parsed.length };
      } catch (error) {
        if (seq !== requestSeq) return { kind: "in_flight" };
        const message = error instanceof Error ? error.message : String(error);
        emit({ ...snapshot, loading: false, error: message });
        return { kind: "error", message };
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

export const officialAnnouncements = createAnnouncementsStore({
  request: (request) => platform.http.request(request),
  siteUrl: () => String(cfg.get("grsai_site_url", DEFAULT_CONFIG.grsai_site_url) || DEFAULT_CONFIG.grsai_site_url),
  language: () => normalizeLanguage(cfg.get("language", "en")),
});

export function useAnnouncements(): AnnouncementsSnapshot {
  return useSyncExternalStore(
    officialAnnouncements.subscribe,
    officialAnnouncements.getSnapshot,
    officialAnnouncements.getSnapshot,
  );
}

/** 一次并行抓取 Grsai 官网的模型数据（可用性 + 积分价目）与官方公告。 */
export async function syncGrsaiSiteData(options: { force?: boolean; siteUrl?: string } = {}): Promise<{
  models: RefreshAvailabilityOutcome;
  announcements: RefreshAnnouncementsOutcome;
}> {
  const [models, announcements] = await Promise.all([
    modelAvailability.refresh(options),
    officialAnnouncements.refresh(options),
  ]);
  return { models, announcements };
}
