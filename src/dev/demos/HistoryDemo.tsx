/**
 * 历史页的预览：先把示例记录种进历史库，再挂上页面。
 * 只跑在浏览器 mock 的开发预览里，不进正式包。
 *
 *   http://localhost:1421/src/dev/index.html?load=/src/dev/demos/HistoryDemo.tsx&name=default
 */
import { useEffect, useState } from "react";
import HistoryPage from "../../pages/HistoryPage";
import type { HistoryTask, NewTaskInput } from "../../core/history";
import { platform } from "../../platform";
import { openHistory } from "../../state/services";

const OUTPUT_DIR = "C:\\mock-data\\output";

/** 一条示例记录：插入用的字段沿用历史库的输入（id 插入时按顺序生成），状态等插完再补。 */
interface Seed extends Omit<NewTaskInput, "id"> {
  status: HistoryTask["status"];
  /** output 目录下的结果文件名。会真的写一个空文件进去，缩略图才找得到。 */
  resultFile?: string;
  /** 只写结果路径、不写文件，用来看结果文件已经被删掉的样子。 */
  lostFile?: string;
  failureReason?: string;
  errorMessage?: string;
}

const LONG_PROMPT =
  "一位穿着白蓝撞色金边立领制服的金发少年骑士站在黄昏的钟楼顶上，披风被高处的风吹得猎猎作响，" +
  "远处是层层叠叠的旧城屋顶和亮起灯火的街道，天边堆着被落日染成琥珀色的云，" +
  "cinematic wide shot, dramatic rim light, ultra detailed, golden hour, 35mm film look";

const LONG_ERROR =
  "The generation request could not be completed. " +
  Array.from({ length: 14 }, (_, index) => `Detail ${index + 1}: upstream worker returned an unexpected payload. `).join("");

/** 按页面上的显示顺序排（最新的在最前）。默认每页 5 条，正好三页。 */
const SEEDS: Seed[] = [
  {
    prompt: "a red apple on a wooden table",
    model: "nano-banana-pro",
    aspectRatio: "1:1",
    imageSize: "1K",
    refImages: ["C:\\mock-data\\samples\\ref_01.png"],
    status: "succeeded",
    resultFile: "grsai_2026-11-25-01-21-29.png",
  },
  {
    prompt: "a paper plane gliding over a city at dusk",
    model: "wan-3.0",
    aspectRatio: "16:9",
    imageSize: "720p",
    duration: 3,
    seed: 123456789,
    status: "succeeded",
    resultFile: "grsai_2026-11-25-01-24-11.mp4",
  },
  {
    prompt: "an astronaut riding a horse",
    model: "gpt-image-2",
    aspectRatio: "16:9",
    imageSize: "16:9",
    status: "failed",
    failureReason: "generate_failed",
    errorMessage: LONG_ERROR,
  },
  {
    prompt: "a street fight at midnight",
    model: "minimax-h3",
    aspectRatio: "9:16",
    imageSize: "720p",
    duration: 5,
    seed: 42,
    status: "violation",
    failureReason: "output_moderation",
    errorMessage: "Output rejected by moderation.",
  },
  {
    prompt: "a lighthouse in a storm",
    model: "nano-banana-2-lite",
    aspectRatio: "4:3",
    imageSize: "1K",
    status: "running",
  },
  {
    // 旧记录：ref_images 存的是单个字符串，模型名也是旧别名
    prompt: "a vintage poster of a steam train",
    model: "gpt-image-1.5",
    aspectRatio: "3:2",
    imageSize: "3:2",
    refImages: "C:\\mock-data\\samples\\ref_02.png",
    status: "succeeded",
    resultFile: "grsai_2026-11-24-22-05-40.png",
  },
  {
    prompt: "结果文件已经被删掉的任务",
    model: "nano-banana",
    aspectRatio: "1:1",
    imageSize: "1K",
    status: "succeeded",
    lostFile: "grsai_2026-11-24-21-48-03.png",
  },
  {
    prompt: "a glass greenhouse in the snow",
    model: "gpt-image-2.6",
    aspectRatio: "1:1",
    imageSize: "1:1",
    status: "succeeded",
    resultFile: "grsai_2026-11-24-20-30-15.png",
  },
  {
    prompt: "a cup of coffee seen from above",
    model: "nano-banana-fast",
    aspectRatio: "1:1",
    imageSize: "1K",
    status: "failed",
    failureReason: "Network Error",
  },
  {
    prompt: "a singer performing on a small stage",
    model: "agnes-video-2.5",
    aspectRatio: "16:9",
    imageSize: "720p",
    duration: 4,
    refAudios: ["C:\\mock-data\\samples\\voice_01.wav"],
    status: "succeeded",
    resultFile: "grsai_2026-11-24-19-12-50.mp4",
  },
  {
    prompt: "a timelapse of clouds over the hills",
    model: "agnes-video-2.5",
    aspectRatio: "16:9",
    imageSize: "720p",
    duration: 6,
    status: "running",
  },
  {
    prompt: LONG_PROMPT,
    model: "nano-banana-2",
    aspectRatio: "16:9",
    imageSize: "2K",
    status: "succeeded",
    resultFile: "grsai_2026-11-24-18-00-00.png",
  },
];

let seeded: Promise<void> | null = null;

function seed(): Promise<void> {
  seeded ??= (async () => {
    const history = await openHistory();
    // 先插最旧的：created_at 相同时按 id 倒序，跨秒时也保持上面的顺序
    for (const [index, item] of [...SEEDS].reverse().entries()) {
      const { status, resultFile, lostFile, failureReason, errorMessage, ...input } = item;
      const id = `demo-${String(index + 1).padStart(2, "0")}`;
      const task = await history.addTask({ ...input, id });
      if (resultFile) await platform.fs.write(platform.paths.join(OUTPUT_DIR, resultFile), new Uint8Array(1));
      const resultName = resultFile ?? lostFile;
      const resultPath = resultName ? platform.paths.join(OUTPUT_DIR, resultName) : null;
      if (status === "succeeded") {
        await history.updateTask(task.id, "succeeded", { resultPath });
      } else if (status !== "running") {
        await history.updateTask(task.id, status, { failureReason: failureReason ?? null, errorMessage: errorMessage ?? null });
      }
    }
  })();
  return seeded;
}

export default function HistoryDemo() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // 种子没种成也让页面照常挂出来，错误在控制台看
    void seed().then(
      () => setReady(true),
      (error: unknown) => {
        console.error(error);
        setReady(true);
      },
    );
  }, []);

  // 先种数据再挂页面：页面一露面就会读历史库，不能让它读到空库
  return ready ? <HistoryPage /> : null;
}
