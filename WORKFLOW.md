# WORKFLOW — 工程来龙去脉与路线图

> 本文档回答三个问题：这套工程是干什么的、怎么运转的、接下来干什么。
> 换电脑（公司 ↔ 家）接续干活时，先读「三、换环境恢复指南」和「五、当前进度」。
> 最后更新：2026-08-28

---

## 一、来龙去脉

本项目起源于真实的内容生产需求：制作**语音讲解型视觉页**——一段口播 MP3 + 逐句字幕 + 素材图片，
合成为约 28 屏自动播放的 HTML 页面（纯原生 HTML + CSS `@keyframes` + 播放脚本），可直接双击播放、录屏出片。

通用低代码引擎（如 Rxdrag）只认自己的 JSON schema，解析不了任意 HTML，因此自研了
**HTML-ZtEdit**：一个直接编辑真实 DOM 的可视化编辑器（拖拽/对齐/改样式不破坏原有动画布局），
配 Electron 打包成免安装 Windows 程序，全程本地运行、绝不联网。

与编辑器配套的还有 `speech-visual-html` 技能（生成端），两者共享一套 **「ztEdit 原生格式」契约**。

## 二、双环工作流

### 主环：内容生产流

```
定稿口播文案
   ↓  (TTS 产线 —— 目前缺失，见路线图 P0-2)
MP3 音频 + SRT/时间轴字幕 + 素材图片(素材1.png…)
   ↓  speech-visual-html 技能 (v5.4)
自动播放 HTML（国风设计系统、scene-plan 分镜、生成时即带 data-zt-* 标记）
   ↓  导入 HTML-ZtEdit
人工精修：拖拽排版对齐 → 字幕校准/跨页 → 字幕↔元素绑定 → 入场/聚焦动画
   ↓
编辑器内播放预览（音频seek+字幕+动画同步）/ 录制
   ↓
导出干净 edited.html（自动重生成播放脚本）→ 双击播放 / 录屏 → 成片
```

### 侧环：工具开发流

用工具做内容的过程中发现摩擦 → 回头修编辑器/技能 → 再投入生产。惯例：

- **多个 AI 会话并行开发**（注意：开工前先 `git pull`，提交后及时 `git push`，避免各会话进度互不知晓）
- Vite/React 本地开发 → `npm run build` 验证 → 中文提交信息（`fix:` / `cleanup:` + 根因描述）
- Electron 打包：双击 `打包.bat`（内置国内镜像）；`stop-dev.bat` 一键释放调试端口
- `样例HTML工程/` 与 `测试工程/` 充当回归测试夹具
- 设计稿（如输入框数字步进）作为 UI 开发参考，功能完成后移出仓库

### 两环的连接契约：ztEdit 原生格式

生成端（speech-visual-html 技能）与编辑器端共同遵守的数据模型，**改动必须两端同版本发布**：

```html
<!-- 字幕（页面内隐藏容器） -->
<div data-zt-role="subtitle"
     data-zt-subtitle-start="0.0"   <!-- 相对当前页的秒数 -->
     data-zt-subtitle-end="12.2">字幕文字</div>

<!-- 画面元素：唯一 id + 动画 + 绑定 -->
<div data-zt-id="el-3-1"
     data-zt-anim-effect="zoom-in"        <!-- 入场动画类型 -->
     data-zt-anim-duration / -delay / -return / -easing
     data-zt-bound-to="[data-zt-id='…']">  <!-- 字幕绑定关系写在字幕侧 -->
</div>
```

- 页面脚本内 `subtitles[]` + `slideTimings[]` 驱动全局时间轴
- 聚焦强调：`focus-zoom` 元素置于 `focus-group` 容器内，触发时同组其余元素变暗
- 当前契约版本 v5.3（技能文档 v5.4）；新增动画类型时需同步升级（见 P0-3）

## 三、换环境恢复指南（公司 ↔ 家）

### 1. 前置环境

- Node.js LTS 18+、npm、Git（Windows 建议 Git Bash）
- 可选：Python 3.10+ / [uv](https://docs.astral.sh/uv/)（跑 `uvx edge-tts` 语音合成与诊断脚本）

### 2. 拉代码与启动

```bash
git clone https://github.com/zhangtown/Html-ZT-Edit.git
cd Html-ZT-Edit
npm install
npm run dev            # 纯 Web 调试（http://localhost:5173）
npm run dev:electron   # Electron 桌面调试模式
# 发布：双击 打包.bat（自动配国内镜像 + npm install + electron-builder）

# 安装仓库内 AI 技能到 ZCode 技能目录（否则不会被自动触发）：
cp -r vo-pipeline ~/.agents/skills/     # speech-visual-html 同理；装完新开会话生效
```

### 3. 不在 git 里的资产（换机器必须手动拷贝！）

| 路径 | 内容 | 拷贝方式 |
| --- | --- | --- |
| `样例HTML工程/` | 唐朝不存在 MP3 + 素材图 + 成品页（gitignore） | U盘/网盘 |
| `设计素材/` | UI 设计参考图（gitignore） | U盘/网盘 |
| 各内容工作目录 | MP3 / SRT / 素材 / 成品 HTML | U盘/网盘 |

> 大文件（MP3、素材库）不走 git。若两机频繁同步，可考虑网盘目录或 git-lfs，暂未配置。

### 4. 进度对齐习惯

开工前 `git pull`；收工（或每完成一个点）`git commit` + `git push`——提交只进本地，GitHub 上看不到。
接手时先看本文档「五、当前进度」和 `git log --oneline -10`。

## 四、目录地图

```
HTML-ZtEdit/
├── WORKFLOW.md            # 本文档
├── README.md              # 功能特性 / 快捷键 / 字幕绑定约定
├── 打包.bat / stop-dev.bat # 一键打包 / 释放调试端口
├── src/
│   ├── App.jsx            # 主界面：工具栏/画布/属性面板/时间轴/通信 (~2300行)
│   ├── editorRuntime.js   # 注入iframe的编辑内核：选中/拖拽/绑定/动画/导出 (~2400行)
│   ├── htmlProcess.js     # 脚本剥离/资源blob重写/导出还原/播放脚本生成
│   ├── recorder.js        # 录屏管线：getDisplayMedia→裁剪iframe→混音→MediaRecorder
│   ├── loadFolder.js / draftStore.js
├── electron/              # 桌面壳（main/preload/dev-runner/sign）
├── speech-visual-html/    # 生成端技能：SKILL.md v5.4 + 模板 + assets
├── 测试工程/              # v5.3 原生格式回归测试页（已入库）
├── 样例HTML工程/          # 完整样例：MP3+素材+成品（gitignore，换机要拷）
└── 设计素材/              # UI设计参考图（gitignore）
```

## 五、当前进度快照（2026-08-28）

**已完成**：
- 播放预览模式：从头/本页播放，音频 seek + 字幕 + 绑定动画同步，停止返回编辑态
- **录制升级（P0-1）达成验收**：Electron 31 原生 MP4 + 离屏定尺寸窗口，窗口任意大小都出 1080P/2K/4K MP4（详见 P0-1）
- 录制管线 v2：捕获隐藏的定尺寸离屏窗口；v1（捕获编辑器窗口 + canvas 裁剪 iframe）保留为纯浏览器兜底
- 字幕绑定/解绑稳定性修复 ×2（跨页兜底查找；selection 消息误清空字幕选中态）
- 工作区清理：调试代码、临时诊断文件、设计素材移出 git
- **vo-pipeline 口播产线技能 v1.1**（edge-tts 引擎全链路实测通过；GPT-SoVITS 克隆路线实测效果不佳，已裁撤）

**已知卡点（即下面 P0 的来源）**：
1. 动画只有 11 种整元素变换（zoom×2/fade/fly×4/bounce/rotate/focus-zoom），缺文字类效果
2. ~~定稿文案 → MP3+SRT 没有自动化产线~~ → vo-pipeline 已建成（纯 edge-tts，克隆路线已裁撤）

## 六、路线图 TODO

### P0 · 出片质量三件套（下一阶段主线）

#### 1. ✅ 录制升级：固定分辨率 + MP4 输出（2026-08-28 完成，A+B 双方案落地）

验收已达成：窗口任意大小都能录出 1080P MP4，成片可直接进剪映/PR。

| 原先方案 | 结论 |
| --- | --- |
| A. 升级 Electron 29 → **31.7.7** | ✅ Chromium 126 起 MediaRecorder 原生支持 MP4。实测 `video/mp4;codecs=avc1.42E01E,mp4a.40.2` 命中，产物文件头 `ftyp mp41` |
| B. 录制与窗口解耦 | ✅ 改为主进程开**隐藏 BrowserWindow**（非 iframe）离屏跑时间轴，实测捕获流精确 1920×1080，与编辑器窗口大小无关 |
| C. ffmpeg 兜底转码 | ⛔ 未采纳，A 已原生支持，省下 80MB 依赖体积 |

实现要点（**改这块代码前必读**）：

- `electron/main.cjs`：`recWin` 为隐藏窗口（`show:false` + `backgroundThrottling:false`），
  用 `setContentSize()` 校准内容区；`setDisplayMediaRequestHandler` 优先返回它，没有则退回主窗口。
- **必须加 `autoplay-policy=no-user-gesture-required`**：离屏页播放由 IPC 触发、无用户手势，
  不加这条 Chromium 会拦掉 `audio.play()`，时间轴不走、只能录到静止首屏。
- **音画同源（关键设计）**：`setDisplayMediaRequestHandler` 里 `callback({video: frame, audio: frame})`，
  音视频都取自离屏窗口 → 偏移 0。最初做成「画面取离屏 + 声音取编辑器 iframe」，
  实测两个独立播放实例有 **22~52ms 恒定偏移**（不累积但可感知），已废弃该做法。
- 静音策略反直觉：离屏页**必须出声**（`muted` 会让 audio 帧捕获不到声音），
  改由 `App.jsx` 在录制时把**编辑器内**那份页面静音（`setEditorAudioMuted`），避免双声源。
- 音频约束：`echoCancellation/noiseSuppression/autoGainControl: false` + `channelCount: 2`。
  默认会开 AGC/降噪把口播人声处理得发闷，且只给单声道。
- `REC_GATE` 脚本注入到离屏页 `<head>` 最前：拦截 `HTMLMediaElement.prototype.play` 挂起自动播放，
  等 `zt:rec-start` 才放行，让离屏页与编辑器内播放同时起步。
- 取页面用 `requestSerialize` 而非 `requestExport`：后者会执行 `exportClean()` 摘掉编辑器样式/脚本，**破坏编辑态**。
- 资源路径：录制 HTML 落在系统临时目录，故用 `fileUrlMapper` 把资源改写成 `file://` 绝对地址指回磁盘原位置；
  导出仍用相对路径，保证 `edited.html` 可分发出去。
- 性能实测（禁 GPU 软件渲染 + 双实例并行，属保守下限）：离屏页渲染 57fps、捕获流 27.2fps（目标 30）；
  真机有 GPU 只会更好。v2 比 v1 更省 CPU，因为省掉了 canvas 逐帧 `drawImage`。
- 实测结论：`show:false` 隐藏窗口能被捕获出真实帧（采样色正确）；
  「窗口移到屏幕外 x=-4000」的方案实测帧宽被裁成 1868，**不可用**。
- 浏览器（非 Electron）模式拿不到资源根目录，自动退回 v1 的窗口捕获 + canvas 裁剪方案。

#### 2. ✅ TTS 口播产线 `vo-pipeline`（阶段1 已建成并实测通过 2026-08-28）

技能落在仓库 `vo-pipeline/`（SKILL.md + 三只脚本 + 音色速查表），并安装到 `~/.agents/skills/`。

- ✅ **阶段1 edge-tts 引擎（默认）**：Phase0 文案口语化打磨指引 → 合成 → **WordBoundary 字级时间戳直接出 SRT**
  （对齐回原文保留标点、按标点自然断条）→ 响度归一 -16 LUFS → 段落间隙 → 试听选音色 → 语速体检（字/秒）。
  零系统依赖（uv 按需拉 edge-tts/mutagen/imageio-ffmpeg）。实测：97字 → 21.9s MP3 + 6条 SRT，时间轴误差 <0.1s
- ⛔ **阶段2 音色克隆（2026-08-28 裁撤）**：GPT-SoVITS 整合包部署 + "小踏音色"端到端实测，
  音色相似度/自然度不达预期，用户拍板回到 edge-tts 通用音色（选音色 + 文案层打磨补足表现力）。
  `tts_gptsovits.py` 已删除、SKILL.md 同步移除；`srt_whisper.py` 保留（SRT 校验兜底，不依赖克隆）
- ✅ 阶段3 去AI味清单已写入 SKILL.md（文案层打磨为收益最大项）

#### 3. 动画扩充（两档实现，契约同步升级）

- **CSS 关键帧档**（低成本，适配现有 from/to 模型）：
  `wipe` 擦除滑入、`flip` 3D翻转、`blur-in` 虚化聚焦、`highlight-sweep` 划线强调、`slide-spin` 旋转滑入
- **脚本驱动档**（需扩展播放脚本 + 导出逻辑 + 技能生成端，即契约 v5.4+）：
  `typewriter` 打字机（按字符步进，步速对齐字幕时间轴）、`stagger` 逐字/逐行入场、
  `counter` 数字滚动、`motion-path` 路径移动
- 两端同发：编辑器下拉/预览/导出 + `speech-visual-html/SKILL.md` 的动画清单同步更新

验收：编辑器可设置可预览，导出页可自动播放，技能生成的页面直接带新效果。

### P1 · 编辑器能力（README 既有规划顺延）

4. **自定义组件库**：选中元素存为组件，跨页/跨项目复用（README 已有概要设计）
5. **源码双向面板**：一期只读高亮联动，二期双向编辑（README 已有概要设计）
6. **页面管理增强**：新增/删除/复制/排序 slide（目前只有前后翻页；做前先确认是否已有部分能力）
7. **草稿版本快照**：IndexedDB 草稿目前只有单份自动保存，增加多步快照防误操作

### P2 · 产线远期

8. **页面直接渲染 MP4**：WebCodecs 离屏逐帧渲染 + mp4-muxer，摆脱实时录屏，根治分辨率/掉帧问题
   （与 P0-1 方案 B 共享隐藏渲染页基础设施）
9. **一键全流程串联**：文案 → vo-pipeline(MP3+SRT) → speech-visual-html(生成) → 人工精修 → 导出/出片，
   用一个脚本/技能把四段串起来
10. **分发打磨**：安装包签名、自动更新（可选）

---

> 维护约定：每完成一项把对应条目移到「五、当前进度」；新卡点随时补进 P0-P2；
> 本文与 README 的 TODO 章节以本文为准。
