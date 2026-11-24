import { PlaceholderPage } from "../components/PlaceholderPage";
import { useTr } from "../hooks/useLanguage";

/** 图像生成页（对应 ui/generator_page.py）；页面内容在 M2 接入。 */
export default function GeneratorPage() {
  const t = useTr();
  return <PlaceholderPage title={t("nav.generator")} />;
}
