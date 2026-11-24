import { PlaceholderPage } from "../components/PlaceholderPage";
import { useTr } from "../hooks/useLanguage";

/** 漫画页（对应 ui/comic_page.py）；页面内容在 M2 接入。 */
export default function ComicPage() {
  const t = useTr();
  return <PlaceholderPage title={t("nav.comic")} />;
}
