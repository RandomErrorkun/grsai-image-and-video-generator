import { PlaceholderPage } from "../components/PlaceholderPage";
import { useTr } from "../hooks/useLanguage";

/** 视频生成页（对应 ui/video_page.py）；页面内容在 M2 接入。 */
export default function VideoPage() {
  const t = useTr();
  return <PlaceholderPage title={t("nav.video")} />;
}
