import { PlaceholderPage } from "../components/PlaceholderPage";
import { useTr } from "../hooks/useLanguage";

/** 历史页（对应 ui/history_page.py）；页面内容在 M2 接入。 */
export default function HistoryPage() {
  const t = useTr();
  return <PlaceholderPage title={t("nav.history")} />;
}
