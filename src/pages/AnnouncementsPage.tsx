/**
 * 官方公告页：启动时自动从 <grsai_site_url>/<lang>/announcements 拉取并渲染。
 * 支持按分类筛选（全部 / 新功能 / 重要通知 / 平台通知）、关键词搜索、展开全文、手动刷新与外部链接跳转。
 */
import { useMemo, useState } from "react";
import { Button, Input } from "@fluentui/react-components";
import { ArrowSync20Regular, Open20Regular, Search20Regular } from "@fluentui/react-icons";
import { notice } from "../components/Notice";
import { DEFAULT_CONFIG } from "../core/config";
import { resolveGrsaiSiteOrigin, type AnnouncementKind } from "../core/modelAvailability";
import { useConfigValue } from "../hooks/useConfigValue";
import { useTr } from "../hooks/useLanguage";
import { normalizeLanguage } from "../i18n";
import { platform } from "../platform";
import { runAsync } from "../platform/async";
import { officialAnnouncements, useAnnouncements } from "../state/announcements";
import "./AnnouncementsPage.css";

type FilterKind = "all" | AnnouncementKind;

export default function AnnouncementsPage() {
  const t = useTr();
  const language = normalizeLanguage(useConfigValue("language", "en"));
  const siteUrl = String(useConfigValue("grsai_site_url", DEFAULT_CONFIG.grsai_site_url) || DEFAULT_CONFIG.grsai_site_url);
  const snapshot = useAnnouncements();
  const [filter, setFilter] = useState<FilterKind>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return snapshot.items.filter((item) => {
      if (filter !== "all" && item.kind !== filter) return false;
      if (!q) return true;
      const haystack = `${item.title} ${item.paragraphs.join(" ")}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [snapshot.items, filter, query]);

  const onRefresh = async () => {
    const result = await officialAnnouncements.refresh({ language });
    if (result.kind === "cooldown") {
      notice("info", t("common.note"), t("model.check_cooldown", { seconds: result.remainingSeconds }));
    } else if (result.kind === "error") {
      notice("warning", t("common.warning"), t("announcements.fetch_failed", { reason: result.message }));
    }
  };

  const openExternal = (url: string) => {
    if (platform.isTauri) runAsync(platform.opener.openPath(url));
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  const origin = resolveGrsaiSiteOrigin(siteUrl);
  const pageUrl = `${origin}/${language === "en" ? "en" : "zh"}/announcements`;

  return (
    <div className="page announcements-page">
      <div className="announcements-page__scroll">
        <header className="announcements-header">
          <div className="announcements-header__left">
            <h2 className="announcements-header__title">{t("announcements.title")}</h2>
            <span className="announcements-header__source">{origin}</span>
          </div>
          <div className="announcements-header__actions">
            <Button appearance="transparent" icon={<Open20Regular />} onClick={() => openExternal(pageUrl)}>
              {t("announcements.open_site")}
            </Button>
            <Button
              appearance="secondary"
              icon={<ArrowSync20Regular />}
              disabled={snapshot.loading}
              onClick={() => runAsync(onRefresh())}
            >
              {t("history.refresh")}
            </Button>
          </div>
        </header>

        <div className="announcements-toolbar">
          <div className="announcements-filters" role="group">
            {(["all", "success", "warning", "info"] as const).map((kind) => (
              <Button
                key={kind}
                size="small"
                appearance={filter === kind ? "primary" : "secondary"}
                onClick={() => setFilter(kind)}
              >
                {t(`announcements.filter.${kind}`)}
              </Button>
            ))}
          </div>
          <Input
            className="announcements-search"
            size="small"
            contentBefore={<Search20Regular />}
            placeholder={t("announcements.search_placeholder")}
            value={query}
            onChange={(_e, data) => setQuery(data.value)}
          />
        </div>

        {snapshot.loading && snapshot.items.length === 0 ? (
          <div className="announcements-state">{t("announcements.loading")}</div>
        ) : snapshot.error && snapshot.items.length === 0 ? (
          <div className="announcements-state announcements-state--error">
            <p>{t("announcements.fetch_failed", { reason: snapshot.error })}</p>
            <Button appearance="primary" size="small" onClick={() => runAsync(officialAnnouncements.refresh({ force: true, language }))}>
              {t("history.refresh")}
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="announcements-state">{t("announcements.empty")}</div>
        ) : (
          <div className="announcements-list">
            {filtered.map((item) => {
              const bodyText = item.paragraphs.join("\n\n");
              const long = bodyText.length > 260 || item.paragraphs.length > 1;
              const isOpen = Boolean(expanded[item.id]);
              return (
                <article key={item.id} className={`announcement-card announcement-card--${item.kind}`}>
                  <div className="announcement-card__header">
                    <div className="announcement-card__badges">
                      <span className={`announcement-badge announcement-badge--${item.kind}`}>
                        {t(`announcements.filter.${item.kind}`)}
                      </span>
                      {item.isNew ? <span className="announcement-badge announcement-badge--new">{t("announcements.new")}</span> : null}
                    </div>
                    {item.date ? <time className="announcement-card__date">{item.date}</time> : null}
                  </div>
                  <h3 className="announcement-card__title">{item.title}</h3>
                  <div className={long && !isOpen ? "announcement-card__body announcement-card__body--clamped" : "announcement-card__body"}>
                    {item.paragraphs.map((para, idx) => (
                      <p key={idx} className="announcement-card__para">
                        {para}
                      </p>
                    ))}
                  </div>
                  {item.links.length > 0 || long ? (
                    <div className="announcement-card__footer">
                      <div className="announcement-card__links">
                        {item.links.map((link) => (
                          <Button
                            key={link.url}
                            size="small"
                            appearance="subtle"
                            icon={<Open20Regular />}
                            onClick={() => openExternal(link.url)}
                          >
                            {link.label}
                          </Button>
                        ))}
                      </div>
                      {long ? (
                        <Button
                          size="small"
                          appearance="transparent"
                          onClick={() => setExpanded((cur) => ({ ...cur, [item.id]: !cur[item.id] }))}
                        >
                          {isOpen ? t("announcements.collapse") : t("announcements.expand")}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
