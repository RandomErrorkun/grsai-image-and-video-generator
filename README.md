# Grsai Image and Video Generator

一款面向 [Grsai](https://grsai.ai) 生成模型中转站的 Windows 桌面客户端，用于图像生成、视频生成、漫画分页创作与本地生成历史管理。

本项目最初基于 [Moeary/Grsai-Banana](https://github.com/Moeary/Grsai-Banana) Fork 至 [RandomErrorkun/Grsai-Banana](https://github.com/RandomErrorkun/Grsai-Banana) 进行功能扩展与模型跟进，随后在此基础上使用 **Tauri 2 + React + TypeScript + Fluent UI v9** 技术栈完成了全新桌面端重写，以获得更小的体积、更流畅的界面体验与更易维护的架构。

## 主要功能

- **图像生成（Nano Banana / GPT Image）**
  - 支持 Nano Banana 系列与 GPT Image 系列（含 VIP 分辨率档位、透明背景、PNG / GIF / SVG 输出格式）。
  - 支持最多 14 张参考图拖放、选择、剪贴板截图/文件粘贴（`Ctrl+V`）。
  - 支持并行多任务提交、失败自动重试与 VIP 违规自动重试开关。
- **视频生成**
  - 支持 `minimax-h3`、`agnes-video-2.5`、`wan-3.0` 等视频模型及各自对应的画面比例、分辨率与时长范围校验。
  - 支持「参考图 / 参考音频 / 参考视频」与「首帧 / 尾帧」两种互斥素材模式，内置参考音频试听、参考视频时长统计与起始秒数/音轨参数配置。
- **3D 姿势工坊（Pose Studio）**
  - 内置离线的 Three.js + MakeHuman 3D 多角色摆姿势工作台（Brotli 压缩单文件内置），支持最多 **26 个角色**同台编辑、29 个中英双语常用姿势、2–6 头身二次元/Q 版体型与比例预设、角色一键适配镜头、OpenPose 骨架图导入与深度翻转修正。
  - 支持 5 套配色方案（Tableau10 / Tableau20 / Rainbow / CSS 148 色）与自定义染色、可定制角色标号（Index）、三点立体光照及 4 种参考图导出模态（3D 人偶、3D 人偶+骨骼、纯 OpenPose 骨架、线性深度图），并支持防遮挡单角水印与按面积占比自动缩放字号。
  - 支持一键导出姿势参考图与 Markdown 身份锚定提示词并发送到图像/视频生成页；姿势工程保存在程序同级 `poses/` 目录并支持多级带空格子目录分类。
- **漫画分页工作台**
  - 支持剧情分页脚本规划、可拖拽重排分页卡片、工程保存/读取与单页/全量出图。
  - 除默认 Grsai 中转的对话模型外，还支持配置第三方 OpenAI 兼容对话接口（自定义 Base URL / Endpoint / API Key / 附加请求体，支持 `/models` 连通测试与模型拉取）。
- **内置媒体灯箱预览**
  - 支持软件内灯箱预览或调用系统默认程序打开（可在设置中切换）。
  - **图片 / SVG**：原生渲染 SVG、顺/逆时针 90° 旋转、滚轮与按钮缩放（10%–800%）、拖拽平移、右键复制图像到剪贴板。
  - **GIF**：基于浏览器原生解码实现按帧播放/暂停、方向键逐帧步进（`←` / `→`）、自定义播放帧率（FPS）、复制当前帧。
  - **视频**：播放/暂停/停止、进度条拖动、静音与音量调节、方向键逐帧步进、复制当前帧。
- **历史记录与断点再获取**
  - 本地 SQLite 数据库持久化管理生成记录，支持分页浏览、任务详情查看、一键回填参数重新生成以及按状态清理。
  - 内置持久化低画质缩略图缓存与结果文件 **SHA-256** 完整性校验：即使输出文件被移动或删除，历史列表中仍保留缩略图供参考；点击打开时会校验文件存在与内容一致性，防止同名替换。
  - 支持单条「再获取」与「获取本页状态」：程序意外关闭后可重新接续远端仍在运行的任务，或补下载已完成任务的结果（Grsai 服务端结果查询有效期为任务完成后 2 小时）。
- **外观与便携体验**
  - 微软 Fluent 设计风格，支持浅色 / 深色 / 跟随系统主题、自定义主题色与中/英文即时切换。
  - 绿色便携架构：配置文件（`grsai_config.json`，分块 v2 结构）、历史库（`grsai_history.db`）、剪贴板缓存（`input/`）、姿势库（`poses/`）与默认输出目录（`output/`）均保存在程序同级目录，兼容旧版本的数据格式。
  - 内嵌私有等宽字体 `JetBrainsMapleMono`（无需安装到系统），并支持在设置页自由调整提示词字号与姿势水印/标号面积占比。
  - 存在未完成任务时关闭窗口自动弹出二次确认，支持提交并发闸控制同时在途的提交请求数。

## 环境要求

- **运行环境**：Windows 10 / 11 x64（系统需具备 Microsoft Edge WebView2 运行时，Windows 11 默认自带）。
- **本地开发构建**：
  - Node.js 20+
  - Rust 工具链（stable）

## 本地开发与构建

```bash
# 安装前端依赖
npm install

# 运行类型检查与单元测试
npm run typecheck
npm test

# 启动桌面端开发模式
npx tauri dev

# 构建 Windows 单文件便携版 exe（产物位于 src-tauri/target/release/grsai-image-and-video-generator_v<version>.exe）
npm run build:exe
```

## 数据与隐私

- API Key 与第三方对话接口 Key 仅保存在程序目录本地的 `grsai_config.json` 中，只用于直接向你配置的接口地址发起请求，不会上传至任何第三方服务。
- 仓库 `.gitignore` 已忽略配置文件、历史数据库与输入输出目录。

## Contributors

- [RandomErrorkun](https://github.com/RandomErrorkun)
- **ZCode**
- **Antigravity**

## 致谢

- 原始项目：[Moeary/Grsai-Banana](https://github.com/Moeary/Grsai-Banana)
- 摆姿势的参考来源：[Work-Fisher/ComfyUI-Fisher-Pose](https://github.com/Work-Fisher/ComfyUI-Fisher-Pose)
- JetBrains Maple Mono 字体：[SpaceTimee/Fusion-JetBrainsMapleMono](https://github.com/SpaceTimee/Fusion-JetBrainsMapleMono)
