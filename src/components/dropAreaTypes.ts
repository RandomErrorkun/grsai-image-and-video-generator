/**
 * 参考图区和参考音频区对外的接口。
 *
 * 生成页、视频页、漫画页三处共用这两个素材区：页面照这里的约定调用，
 * 实现照源项目的 ui/components/image_drop_area.py 和 audio_drop_area.py。
 * 实现文件是同目录下的 ImageDropArea.tsx 和 AudioDropArea.tsx，都是默认导出。
 */
import type { Ref } from "react";
import type { VideoReferenceOption } from "../core/api";
import type { VideoReferenceField } from "../core/modelCatalog";

export interface ImageDropAreaHandle {
  /** 当前参考图的本地路径，按加入的顺序；对应源项目的 image_paths。 */
  getPaths(): string[];
  /** 加一张图，超限或格式不对时给提示；对应 add_image。 */
  addImage(path: string): Promise<void>;
  clearImages(): void;
  /** 读剪贴板贴进来，位图和文件列表都认；对应 paste_from_clipboard。 */
  pasteFromClipboard(): Promise<void>;
}

export interface ImageDropAreaProps {
  ref?: Ref<ImageDropAreaHandle>;
  /** 最多放几张。视频页会随模型改这个值，多出来的图怎么处理照源项目。 */
  maxImages: number;
  /** 占位文案的键。视频页的首帧和尾帧用它换成各自的说明；不给就用 drop.placeholder。 */
  placeholderKey?: string;
  /** 列表变了就通知一次，给出最新的路径列表。 */
  onChange?: (paths: string[]) => void;
  className?: string;
}

export interface AudioDropAreaHandle {
  /** 当前音频的本地路径，按加入的顺序；对应源项目的 audio_paths。 */
  getPaths(): string[];
  /** 对应 add_files。showLimitWarning 为假时超限只截断、不提示，恢复历史参数时用。 */
  addFiles(paths: string[], options?: { showLimitWarning?: boolean }): Promise<void>;
  clearAudios(): void;
  /** 对应 open_file_dialog。 */
  openFileDialog(): Promise<void>;
}

export interface AudioDropAreaProps {
  ref?: Ref<AudioDropAreaHandle>;
  maxFiles: number;
  /** 列表变了就通知一次，给出最新的路径列表。 */
  onChange?: (paths: string[]) => void;
  className?: string;
}

export interface VideoReference {
  /** 本地文件路径。 */
  path: string;
  /** agnes-video-2.5 的 startSeconds：从第几秒开始读；null 表示不传，按接口的默认值 0；NaN 表示输入非法。 */
  startSeconds: number | null;
  /** agnes-video-2.5 的 requireAudio。 */
  requireAudio: boolean;
  /** 探测到的时长（秒）；未知或解不了码时为 null。 */
  durationSeconds?: number | null;
  /** 起始秒数输入框的原始文本。 */
  startSecondsText?: string;
}

export interface VideoDropAreaHandle {
  getVideos(): VideoReference[];
  /** 对应参考音频的 addFiles：超限只收前几个；showLimitWarning 为假时超限不提示；itemOptions 用于历史恢复回填每条的选项。 */
  addVideos(
    paths: string[],
    options?: {
      showLimitWarning?: boolean;
      itemOptions?: readonly (VideoReferenceOption | null | undefined)[] | null;
    },
  ): Promise<void>;
  clearVideos(): void;
  openFileDialog(): Promise<void>;
}

export interface VideoDropAreaProps {
  ref?: Ref<VideoDropAreaHandle>;
  /** 最多几段。 */
  maxVideos: number;
  /** 条目里声明的附加字段，决定「起始秒数」和「音轨」两列显示不显示。 */
  fields?: readonly VideoReferenceField[];
  onChange?: (videos: VideoReference[]) => void;
  className?: string;
}
