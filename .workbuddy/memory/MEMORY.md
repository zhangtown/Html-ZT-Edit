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
- **`src/animEffects.js`（2026-08-29 新增）：动画效果清单 + 引擎源码的唯一出处。**
  预览 / 导出脚本 / 播放录屏 三端全部消费它。改动画只改这个文件，改完跑 `npm run check:anim`。
  引擎源码经 App postMessage 下发（runtime 是 `?raw` 注入的纯脚本，不能 import）。

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
- **播放/录屏不走编辑器的动画引擎，走页面自带的原生播放脚本**（`startPlay` 里
  `if (nativeScript && hasAudio)` → `injectNativePlayer()`）。那段脚本是生成 HTML 那一刻的引擎快照，
  效果表永远停在旧版本。曾因此出现「预览对、导出对、播放录屏错」（旧 default 分支 = scale(1.2) 放大）。
  现由 `patchNativeEngine()` 在注入前把它的 `getEffectKeyframes`/`playAnimation` 整体换成当前引擎；
  两个函数要么都换成功要么都不换 —— 只换一个会让新 keyframes 返回 null 撞上旧 playAnimation，
  抛异常直接打死整条播放循环，比动画不对更糟。
- `selection` 消息**不要**清空 `selectedSubIdx`，否则「解除绑定」会走 `unbindSelectedElement` 分支而失效。
- 导出必须把 `.slide.active` 重置到第一页，否则自动播放时首屏不显示（脚本 currentSlide 与实际不一致）。
- `vite.config.js` 设了 `emptyOutDir: false` → `dist/` 会堆积历史产物（曾累到 26 个 js / 5.6MB），
  而 electron-builder 按 `dist/**/*` 全量打包。**打包前先 `rm -rf dist && npm run build`**。
- 改主进程（`electron/main.cjs`、`preload.cjs`）需重启 dev:electron；`src/` 走 HMR。

## 调试方式
- 桌面端窗口按 **F12** 或 **Ctrl+Shift+I** 开合 DevTools。快捷键在 `main.cjs` 的
  `webContents.on('before-input-event')` 里显式注册 —— Electron 默认菜单并不保证带这些键，
  不注册的话 F12 常常没反应。
- 录屏产物若没音轨，App 会在保存前弹「录屏自检」信息（录制模式/格式/送入音轨数/root 状态），
  排查静音问题先看这个弹窗，其次看 console 里的 `[ZT-Edit] 录屏自检`。
- 国内镜像地址（**已实测可达，别改成 README 里那种旧写法**）：
  `ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/`
  `ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/`
  旧写法 `https://npmmirror.com/mirrors/electron-builder-binary/` 会 302 跳到 HTML 索引页，不是二进制目录。

### 录屏（v2 离屏架构，Electron 31.7.7）
- **必须保留 `autoplay-policy=no-user-gesture-required`**：离屏页播放由 IPC 触发、无用户手势，
  否则 Chromium 拦掉 `audio.play()`，时间轴不走、只能录到静止首屏。
- 取页面用 `requestSerialize` 而非 `requestExport`：后者执行 `exportClean()` 摘掉编辑器样式/脚本，**破坏编辑态**。
- 离屏窗口用 `show:false` + `backgroundThrottling:false`（实测能捕获到真实帧）；
  「移到屏幕外 x=-4000」实测帧宽被裁成 1868，**不可用**。
- 录制 HTML 落在系统临时目录，资源靠 `fileUrlMapper` 改写成 `file://` 绝对地址指回磁盘；
  导出仍用相对路径，`edited.html` 才能分发给别人。
- **音画同源是关键**：`setDisplayMediaRequestHandler` 里 `callback({video: frame, audio: frame})`，
  音视频都取自离屏窗口，偏移为 0。早期做成「画面取离屏 + 声音取编辑器 iframe」，
  实测两个独立播放实例有 **22~52ms 恒定偏移**（不累积、但可感知），已废弃。
- 静音策略是**反直觉的**：离屏页**必须出声**（`muted` 会让 audio 帧捕获不到声音），
  改由 App.jsx 在录制时把**编辑器内**那份页面静音，避免双声源。
- 音频约束务必 `echoCancellation/noiseSuppression/autoGainControl: false` + `channelCount: 2`，
  否则口播人声被处理得发闷，且只有单声道。
- 录制准备中途失败必须在 catch 里 `ztRecSession.close()` + 恢复编辑器声音，否则离屏窗口一直霸占捕获源。
- `zt:rec-prepare` 里**必须先 `createRecWindow()` 再 `writeTempHtml()`**：
  `createRecWindow()` 内部第一行就是 `destroyRecWindow()`，它会清空 `recTmpFile` 并删掉那个临时文件。
  顺序写反了会导致刚写的文件被自己删掉、`loadFile(null)` 抛 "Must pass filePath as a string"（已踩过一次）。
- 草稿必须存 `root`：`recRoot` 只在「选择 HTML 文件」时记录，**刷新后从草稿恢复时是空的**，
  离屏录制会静默退回窗口捕获兜底方案（webm + 分辨率随窗口）。已用 `draft.root` + `zt:set-root` 回填解决。
- **离屏窗口尺寸不能超过屏幕**：一旦超过，Chromium 干脆不渲染（页面加载 `ERR_FAILED`，录出来画面静止）。
  判定时取 `screen.getAllDisplays()` 里最大的 `bounds`（**不是 `workAreaSize`**——任务栏吃掉的那几十像素
  会把 2K 档误判成不可用）；UI 据此置灰超出的档位，录制时还会自动降级并弹提示。
  `createRecWindow()` 里也要把窗口 x/y 放到放得下它的那块屏，否则多屏环境下会被按当前屏裁剪。
- 播放脚本里 `getElementById('bgAudio')` 曾写死：页面用别的 id 时 `audio` 为 null，
  时间轴整个哑掉但 CSS 动画照常跑，现象酷似「录屏没声音」。已改为 `|| document.querySelector('audio')`。
- 性能实测（禁 GPU 软件渲染 + 双实例并行，属保守值）：离屏页渲染 57fps、捕获流 27.2fps（目标 30），
  真机有 GPU 更好；v2 比 v1 更省，因为省掉了 canvas 逐帧 drawImage。
- Chromium 126 起 MediaRecorder 原生支持 MP4（avc1+aac），产物头 `ftyp mp41`，**不需要 ffmpeg 转码**。
- 浏览器（非 Electron）模式拿不到资源根目录，自动退回 v1：捕获编辑器窗口 + canvas 裁剪，输出 webm、分辨率随窗口。

## 相关目录
- `speech-visual-html/` 生成端技能（SKILL.md v5.4 + 模板 + assets）
- `vo-pipeline/` 口播产线（edge-tts 引擎已实测；GPT-SoVITS 待部署）
- `测试工程/speech-visual-test.html` v5.3 契约回归夹具；`样例HTML工程/` 完整样例（gitignore，换机要手拷）
- `WORKFLOW.md` 是路线图与换机恢复的唯一权威；README 的 TODO 以 WORKFLOW 为准。
