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
- 录制管线 v1：getDisplayMedia 捕获窗口 → 实时裁剪 iframe → 混入页面音轨 → MediaRecorder
- 字幕绑定/解绑稳定性修复 ×2（跨页兜底查找；selection 消息误清空字幕选中态）
- 工作区清理：调试代码、临时诊断文件、设计素材移出 git

**已知卡点（即下面 P0 的来源）**：
1. 录制输出 webm 而非 MP4 —— Electron 29（Chromium 120）的 MediaRecorder 不支持 video/mp4，`pickMime()` 的 mp4 候选全部落空
2. 录制分辨率随窗口尺寸走 —— 画布按 iframe 在窗口内的实际显示大小裁剪，窗口小则成片小
3. 动画只有 11 种整元素变换（zoom×2/fade/fly×4/bounce/rotate/focus-zoom），缺文字类效果
4. 定稿文案 → MP3+SRT 没有自动化产线，语音合成靠手动零散操作

## 六、路线图 TODO

### P0 · 出片质量三件套（下一阶段主线）

#### 1. 录制升级：固定分辨率 + MP4 输出

| 方案 | 做法 | 代价/风险 |
| --- | --- | --- |
| A. 升级 Electron ≥31（推荐先做） | Chromium 126+ 的 MediaRecorder 原生支持 `video/mp4`（avc1+aac），`pickMime()` 无需改动即可命中 | 需回归测试录制/播放；打包体积略增 |
| B. 录制与窗口解耦（根治分辨率） | 隐藏的定尺寸 iframe（1920×1080，可选 4K）离屏播放时间轴，`captureStream` 固定分辨率，码率提到 12–20 Mbps | 中等工作量，需复用播放引擎在隐藏页跑时间轴 |
| C. ffmpeg 兜底转码 | `ffmpeg-static` 依赖：webm → MP4 (H.264/AAC)，顺带做响度归一 loudnorm | 依赖体积 +80MB；作为 A 不可用时的后备 |

验收：窗口任意大小都能录出 1080p MP4，成片可直接进剪映/PR。

#### 2. TTS 口播产线（新技能，建议名 `vo-pipeline`，或并入 speech-visual-html 作 Phase 0）

定稿文案一键产出 `口播.MP3 + 口播.srt`，直接可喂给 speech-visual-html。

- **阶段 1 · 零成本立即可做**：文案 → 口语化分句（句长控制、停顿标注、数字读法/多音字处理）
  → `edge-tts` 合成（音色库清单+试听对比表，rate/pitch/volume 参数化）
  → 用 edge-tts 的 WordBoundary 事件直接生成 SRT（无需 ASR，时间轴精度高）
  → ffmpeg 响度归一、首尾静音修剪
- **阶段 2 · 音色克隆选型**（学习"我的音色"）：
  - 本地路线：GPT-SoVITS / CosyVoice2 / F5-TTS / IndexTTS（几秒参考音频零样本克隆，中文效果好；
    需要 ≥6–8GB 显存的 NVIDIA GPU，Windows 有整合包）
  - API 路线（无 GPU 备选）：fish-audio / MiniMax / Azure 自定义神经语音（注意成本与隐私合规）
  - 克隆音色输出 WAV 后，用 whisperX / faster-whisper 做强制对齐生成 SRT
- **阶段 3 · 去AI味持续迭代**：语气词注入、break 停顿、逐句 rate 微调、情感参数、批量试听评分表

卡点/决策点：两台机器有无 NVIDIA GPU 决定走本地克隆还是 API。

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
