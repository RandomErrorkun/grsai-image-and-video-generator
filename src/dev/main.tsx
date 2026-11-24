/**
 * 开发时单独预览一个组件或页面，只跑在 npm run dev 的浏览器 mock 里，不进正式包。
 *
 *   http://localhost:1421/src/dev/index.html?demo=tasklist                    预览下面登记好的示例
 *   http://localhost:1421/src/dev/index.html?load=/src/pages/X.tsx&name=default   预览任意模块的导出
 */
import { useEffect, useRef, useMemo, useState, type ComponentType, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { Button, Input } from "@fluentui/react-components";
import { AppProvider } from "../components/AppProvider";
import PromptWidget, { type PromptWidgetHandle } from "../components/PromptWidget";
import { TaskListView } from "../components/TaskList";
import { useConfigValue } from "../hooks/useConfigValue";
import { normalizeLanguage, setLanguage } from "../i18n";
import { platform } from "../platform";
import { cfg } from "../state/config";
import { taskScheduler } from "../state/services";
import { TaskList } from "../state/taskList";
import "../styles/app.css";
import "./dev.css";

const run = (action: Promise<void> | undefined) => void action?.catch(() => {});

/** 提示词输入框：下面一行按钮演示页面怎么通过 ref 取文本。 */
function PromptDemo() {
  const promptRef = useRef<PromptWidgetHandle>(null);
  const [picked, setPicked] = useState("");
  return (
    <div className="demo-frame">
      <PromptWidget ref={promptRef} className="demo-grow" />
      <div className="demo-row">
        <Button onClick={() => setPicked(promptRef.current?.getPrompt() ?? "")}>getPrompt()</Button>
        <Button onClick={() => promptRef.current?.setPrompt("a red apple on a wooden table")}>setPrompt()</Button>
        <Button onClick={() => promptRef.current?.clear()}>clear()</Button>
        <Button onClick={() => run(promptRef.current?.pasteFromClipboard())}>paste()</Button>
        <span className="demo-note">{picked ? `取到：${picked}` : "还没有取过"}</span>
      </div>
    </div>
  );
}

/** 任务列表：加几个任务，看排队、提交、进度、成功、失败和重试的卡片。 */
function TaskListDemo() {
  const list = useMemo(
    () =>
      new TaskList({
        scheduler: taskScheduler,
        settings: () => ({ maxRetries: 2, vipModerationRetry: false }),
      }),
    [],
  );
  const [prompt, setPrompt] = useState("a cat");
  const [autoRetry, setAutoRetry] = useState(true);
  const add = (text: string, model = "nano-banana") =>
    list.create({ prompt: text, spec: { prompt: text, model }, autoRetry });
  return (
    <div className="demo-frame">
      <div className="demo-row">
        <Input value={prompt} onChange={(_event, data) => setPrompt(data.value)} aria-label="prompt" />
        <Button appearance="primary" onClick={() => add(prompt)}>
          Add
        </Button>
        <Button onClick={() => setAutoRetry((value) => !value)}>Auto retry: {autoRetry ? "on" : "off"}</Button>
      </div>
      <div className="demo-row">
        <Button onClick={() => add("MOCK_FAIL", "gpt-image-2")}>fail</Button>
        <Button onClick={() => add("MOCK_VIOLATION", "gpt-image-2-vip")}>VIP violation</Button>
        <Button onClick={() => add("MOCK_UNKNOWN")}>unknown</Button>
        <Button onClick={() => add("MOCK_SLOW", "wan-3.0")}>slow video</Button>
        <Button onClick={() => add("MOCK_PAIR")}>pair</Button>
        <Button onClick={() => void list.stopAll()}>stop all</Button>
      </div>
      <p className="demo-note">
        提示词里的 MOCK_FAIL、MOCK_VIOLATION、MOCK_UNKNOWN、MOCK_SLOW、MOCK_PAIR 是假接口认的触发词，见 platform/mockApi.ts。
      </p>
      <TaskListView
        list={list}
        onRegenerate={(card) => void list.regenerate(card.index, autoRetry)}
        className="demo-tasks"
      />
    </div>
  );
}

/** 和外壳一样，让文案表跟着配置里的 language 走。 */
function DevRoot({ children }: { children?: ReactNode }) {
  const language = normalizeLanguage(useConfigValue("language", "en"));
  useEffect(() => {
    setLanguage(language);
  }, [language]);
  return <AppProvider>{children}</AppProvider>;
}

const DEMOS: Record<string, ComponentType> = {
  prompt: PromptDemo,
  tasklist: TaskListDemo,
};

const params = new URLSearchParams(window.location.search);

function show(message: string): void {
  const root = document.getElementById("root");
  if (root) root.textContent = message;
}

async function bootstrap(): Promise<void> {
  await platform.init();
  await cfg.load();
  setLanguage(normalizeLanguage(cfg.get("language", "en")));

  const demo = params.get("demo");
  const load = params.get("load");
  const name = params.get("name") ?? "default";
  let Component: ComponentType | undefined;
  if (demo) Component = DEMOS[demo];
  if (!Component && load) {
    try {
      const module: Record<string, unknown> = await import(/* @vite-ignore */ load);
      const exported = module[name];
      Component = typeof exported === "function" ? (exported as ComponentType) : undefined;
    } catch (error) {
      show(`Could not load ${load}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
  if (!Component) {
    show("Usage: ?demo=prompt|tasklist  or  ?load=/src/pages/X.tsx&name=default");
    return;
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <DevRoot>
      <Component />
    </DevRoot>,
  );
}

void bootstrap();
