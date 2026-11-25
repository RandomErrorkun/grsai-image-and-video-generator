/**
 * 开发预览：参考图区和参考音频区。只跑在浏览器 mock 里，不进正式包。
 *
 *   http://localhost:1421/src/dev/index.html?load=/src/dev/demos/DropAreaDemo.tsx&name=default
 *
 * 按钮行演示页面怎么通过 ref 调用 handle 上的方法，顺便把上限、运行中改小上限、
 * 首尾帧槽位的占位文案这几条路都踩一遍。拖放、点选和 Ctrl+V 照常直接操作。
 */
import { useRef, useState } from "react";
import { Button } from "@fluentui/react-components";
import AudioDropArea from "../../components/AudioDropArea";
import ImageDropArea from "../../components/ImageDropArea";
import type { AudioDropAreaHandle, ImageDropAreaHandle } from "../../components/dropAreaTypes";
import { parseFileFilter } from "../../components/dropAreaLogic";
import { tr } from "../../i18n";
import { platform } from "../../platform";
import { runAsync } from "../../platform/async";

/** mock 的对话框会按筛选条件现做样例文件并登记页面地址，这里借它把样例备好。 */
async function samplePaths(kind: "image" | "audio"): Promise<string[]> {
  const filter = kind === "audio" ? tr("audio.dialog.filter") : tr("drop.dialog.filter");
  return platform.dialog.pickFiles({ multiple: true, filters: [parseFileFilter(filter)] });
}

/** 样例只有两三个，不够踩上限：照着样例的内容在 input 目录下另存几份。 */
async function extraPaths(kind: "image" | "audio", count: number): Promise<string[]> {
  const samples = await samplePaths(kind);
  const template = samples[0];
  if (template === undefined) return [];
  const bytes = await platform.fs.read(template);
  const extension = platform.paths.splitExt(template)[1];
  const result: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const path = platform.paths.join(platform.dataDir, "input", `extra_${String(index).padStart(2, "0")}${extension}`);
    await platform.fs.write(path, bytes);
    result.push(path);
  }
  return result;
}

/** 外层撑满给它，组件自己就会铺开；占位用 grid 的拉伸，不用另写样式。 */
const fill = { display: "grid", gridTemplateRows: "minmax(0, 1fr)", minHeight: 0 } as const;
/** 这一行里的几栏都要拉到一样高，demo-row 默认是垂直居中对齐的。 */
const stretchRow = { flex: 1, minHeight: 0, alignItems: "stretch" } as const;

export default function DropAreaDemo() {
  const images = useRef<ImageDropAreaHandle>(null);
  const firstFrame = useRef<ImageDropAreaHandle>(null);
  const lastFrame = useRef<ImageDropAreaHandle>(null);
  const audio = useRef<AudioDropAreaHandle>(null);
  const [maxImages, setMaxImages] = useState(14);
  const [maxFiles, setMaxFiles] = useState(3);
  const [imageList, setImageList] = useState<string[]>([]);
  const [audioList, setAudioList] = useState<string[]>([]);
  const [report, setReport] = useState("");

  const say = (text: string) => setReport(text);

  const addSamples = async (target: typeof images, count: number) => {
    const samples = await samplePaths("image");
    for (let index = 0; index < count; index += 1) {
      // 已有的路径会被跳过，所以轮着换样例
      await target.current?.addImage(samples[index % samples.length] ?? "");
    }
    say(`${count} 次 addImage() 之后：${target.current?.getPaths().length ?? 0} 张`);
  };

  const addExtra = async (count: number) => {
    for (const path of await extraPaths("image", 20)) {
      // 逐个 addImage，和视频页恢复历史参数时的写法一样；超限时每一次都会提示
      await images.current?.addImage(path);
    }
    say(`逐个 addImage() ${count} 个之后：${images.current?.getPaths().length ?? 0} 张`);
  };

  const addAudio = async (count: number, options?: { showLimitWarning?: boolean }) => {
    const paths = [...(await samplePaths("audio")), ...(await extraPaths("audio", 20))].slice(0, count);
    await audio.current?.addFiles(paths, options);
    say(`addFiles() ${count} 个之后：${audio.current?.getPaths().length ?? 0} 个`);
  };

  const showPaths = () =>
    say(
      [
        `参考图 ${images.current?.getPaths().length ?? 0} 张，首帧 ${firstFrame.current?.getPaths().length ?? 0} 张，尾帧 ${lastFrame.current?.getPaths().length ?? 0} 张`,
        `音频 ${audio.current?.getPaths().length ?? 0} 个`,
      ].join("；"),
    );

  return (
    <div className="demo-frame">
      <div className="demo-row">
        <Button onClick={() => runAsync(addSamples(images, 1))}>addImage × 1</Button>
        <Button onClick={() => runAsync(addSamples(images, 3))}>addImage × 3</Button>
        <Button onClick={() => runAsync(addExtra(20))}>addImage × 20（超出上限）</Button>
        <Button onClick={() => runAsync(images.current?.pasteFromClipboard() ?? Promise.resolve())}>paste()</Button>
        <Button onClick={() => images.current?.clearImages()}>clearImages()</Button>
        <Button onClick={() => setMaxImages(14)}>max 14</Button>
        <Button onClick={() => setMaxImages(5)}>max 5</Button>
        <Button onClick={() => setMaxImages(1)}>max 1</Button>
        <Button onClick={showPaths}>getPaths()</Button>
      </div>
      <p className="demo-note">
        参考图上限现在是 {maxImages}；onChange 收到 {imageList.length} 张。{report}
      </p>
      <div className="demo-row" style={{ ...stretchRow, gap: 16 }}>
        <div style={{ ...fill, flex: 3 }}>
          <ImageDropArea ref={images} maxImages={maxImages} onChange={setImageList} />
        </div>
        <div style={{ display: "flex", flex: 2, flexDirection: "column", gap: 10 }}>
          <div style={{ ...fill, flex: 1, minHeight: 110 }}>
            <ImageDropArea ref={firstFrame} maxImages={1} placeholderKey="video.first_frame_placeholder" />
          </div>
          <div style={{ ...fill, flex: 1, minHeight: 110 }}>
            <ImageDropArea ref={lastFrame} maxImages={1} placeholderKey="video.last_frame_placeholder" />
          </div>
        </div>
      </div>
      <div className="demo-row">
        <Button onClick={() => runAsync(addSamples(firstFrame, 1))}>首帧 addImage</Button>
        <Button onClick={() => runAsync(addSamples(lastFrame, 1))}>尾帧 addImage</Button>
        <Button onClick={() => firstFrame.current?.clearImages()}>首帧 clear</Button>
        <Button onClick={() => lastFrame.current?.clearImages()}>尾帧 clear</Button>
      </div>
      <div className="demo-row">
        <Button onClick={() => runAsync(addAudio(2))}>addFiles × 2</Button>
        <Button onClick={() => runAsync(addAudio(6, { showLimitWarning: true }))}>addFiles × 6（提示）</Button>
        <Button onClick={() => runAsync(addAudio(6, { showLimitWarning: false }))}>addFiles × 6（不提示）</Button>
        <Button onClick={() => runAsync(audio.current?.openFileDialog() ?? Promise.resolve())}>openFileDialog()</Button>
        <Button onClick={() => audio.current?.clearAudios()}>clearAudios()</Button>
        <Button onClick={() => setMaxFiles(1)}>max 1</Button>
        <Button onClick={() => setMaxFiles(3)}>max 3</Button>
        <Button onClick={() => setMaxFiles(5)}>max 5</Button>
      </div>
      <div style={{ ...fill, gridTemplateRows: "auto" }}>
        <AudioDropArea ref={audio} maxFiles={maxFiles} onChange={setAudioList} />
      </div>
      <p className="demo-note">音频上限现在是 {maxFiles}；onChange 收到 {audioList.length} 个。</p>
    </div>
  );
}
