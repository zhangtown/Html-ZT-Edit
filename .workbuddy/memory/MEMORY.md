# Html-ZT-Edit 项目长期记忆

## 它是干什么
手写原生 HTML 讲解型视觉页（自动播放 + 口播音频 + 字幕）的可视化编辑器。
核心理念：**直接改真实 DOM**，不引入物料模型，保留原页面的 CSS 动画与绝对定位布局。
全程本地运行、绝不联网；Electron 打包成免安装 Windows 程序。

## 技术栈
Vite 5 + React 18（纯前端无后端）+ Electron 29 桌面壳 + IndexedDB 草稿。

## 架构（改代码前必读）
- **父窗口** `src/App.jsx`（~2270 行）：工具栏 / 属性面板 / 图层 / 时间轴 / 消息中转 / 草稿 / 导出 / 录屏调度。
- **iframe** `src/editorRuntime.js`（~2410 行）：以字符串（Vite `?raw`）注入的**纯脚本，不能用 import/export**。
  负责选中、拖动、缩放手柄、框选、智能参考线、对齐分布、组合锁定、撤销重做、复制粘贴、字幕绑定、动画、播放预览。
- 二者通过 `postMessage` 通信；父端 `send(msg)`，iframe 内 `post(msg)`，消息类型集中在
  App.jsx 的 `onMessage` 与 runtime 的 `init()` 里（改动要两端同步）。
- 辅助模块：`loadFolder.js`（文件夹选择/相对路径解析）、`htmlProcess.js`（剥脚本/资源 blob 重写/导出还原/播放脚本生成）、
  `draftStore.js`（IndexedDB）、`recorder.js`（getDisplayMedia → canvas 裁剪 → MediaRecorder）。

## 数据流要点
1. 加载：`stripScripts` 剥离脚本 → `rewriteAssets` 把相对资源转 blob 并记 `relMap(blob→原引用)` → 拼装注入 → iframe `srcdoc`。
2. 编辑：所有编辑动作在 iframe 内产生 `changed` → 父端防抖 800ms → `requestSerialize` → 存 IndexedDB。
3. 导出：`exportClean()` 清编辑器足迹 + 重置首屏 `active` → 父端 `restoreAndWrap` 还原相对路径并**重新生成播放脚本**。

## ztEdit 原生格式契约（与生成端 speech-visual-html 技能共用，改契约两端同发）
- 字幕：`<div data-zt-role="subtitle" data-zt-subtitle-start="0.0" data-zt-subtitle-end="12.2">`（相对本页秒数）
- 画面元素：`data-zt-id` 唯一 id；`data-zt-anim-effect` ∈ zoom-in/zoom-out/fade-in/fly-*/bounce/rotate/focus-zoom，
  配 `-duration/-delay/-return/-easing`
- 绑定：**写在字幕侧** `data-zt-bound-to="[data-zt-id='…']"`
- 聚焦强调：`focus-zoom` 元素置于 `.focus-group` 容器，触发时同组 `.focus-item` 变暗（`dim-others`）
- 全局时间轴：页面脚本里的 `subtitles[]` + `slideTimings[]`

## 已知坑
- `selection` 消息**不要**清空 `selectedSubIdx`，否则「解除绑定」会走 `unbindSelectedElement` 分支而失效。
- 导出必须把 `.slide.active` 重置到第一页，否则自动播放时首屏不显示（脚本 currentSlide 与实际不一致）。
- `vite.config.js` 设了 `emptyOutDir: false`（构建时批量删文件会触发本机安全确认中断构建）；需清干净请手动删 `dist/`。
- Electron 29 的 MediaRecorder 不支持 `video/mp4`，录屏实际输出 webm（P0 待办：升 Electron ≥31）。
- 改主进程（`electron/main.cjs`、`preload.cjs`）需重启 dev:electron；`src/` 走 HMR。

## 相关目录
- `speech-visual-html/` 生成端技能（SKILL.md v5.4 + 模板 + assets）
- `vo-pipeline/` 口播产线（edge-tts 引擎已实测；GPT-SoVITS 待部署）
- `测试工程/speech-visual-test.html` v5.3 契约回归夹具；`样例HTML工程/` 完整样例（gitignore，换机要手拷）
- `WORKFLOW.md` 是路线图与换机恢复的唯一权威；README 的 TODO 以 WORKFLOW 为准。
