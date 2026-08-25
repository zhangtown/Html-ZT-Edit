---
name: speech-visual-html
description: 将演讲字幕时间轴和音频文件生成为自动播放的HTML视觉页面（ztEdit 原生格式，双击可录屏播放，导入 ztEdit 可编辑字幕/动画绑定/时间轴）。支持国风设计系统、focus-zoom 聚焦动画、字幕-元素绑定、图片拆分动效、新中式Hero布局、Edge-TTS语音生成、模板化自动播放。集成 srt-remotion-video 智能分镜与视觉设计系统：语义分组、12种容器类型、scene-plan驱动HTML生成。
triggers:
  - "演讲"
  - "字幕"
  - "时间轴"
  - "MP3"
  - "素材"
  - "PPT"
  - "网页"
  - "HTML"
  - "自动播放"
  - "国风"
  - "视频脚本"
  - "MG动画"
version: 5.2
defaultTemplate: 模板-唐朝不存在风格-v5.1.html
---

# Speech Visual HTML Generator v5.3

> **默认风格**：基于"唐朝不存在"项目（2026.07.31 最终版），包含分批飞入封面、内容优先聚焦系统、左文右图布局。
> 旧版风格（毒教材项目、mg-hide 模式）已归档，新项目优先使用 v5.3（ztEdit 原生格式）。

## 技能概述

将演讲音频字幕时间轴文件、MP3音频文件及素材图片，自动生成为可自动播放的HTML视觉页面。v4.0 全面升级：新增国风设计系统、MG动画引擎、图片拆分动效、字幕聚焦效果、新中式Hero布局、Edge-TTS语音生成、模板化自动播放架构。

## 触发条件

用户输入以下任意模式时触发：
- "生成演讲视觉页面/HTML/PPT网页版"
- "字幕+时间轴.txt + MP3 + 素材图片"
- "国风/中式风格的演讲页面"
- "给这个脚本做MG动画页面"
- 包含字幕文件 + 音频文件 + 素材图片的混合请求

## 输入文件格式要求

| 文件类型 | 命名格式 | 用途 |
|:---|:---|:---|
| 字幕时间轴 | `XX- 字幕+时间轴.txt` 或 `XX.srt` | 逐句字幕，含时间戳（`.txt` 和 `.srt` 均支持） |
| 音频文件 | `XX.MP3` 或 `XX.mp3` | 演讲音频，自动播放同步 |
| 素材图片 | `素材1.jpg`、`素材2.png`... | 画面内容支撑 |
| Edge-TTS语音 | 自动生成 | 无音频时自动调用 edge-tts 生成语音 |
| 头像（可选） | `头像.jpg` | 演讲人头像 |
| 风格参考（可选） | `页面风格参考.png` | 视觉风格参考 |

## 输出文件

| 文件 | 说明 |
|:---|:---|
| `XX视觉文案规划.md` | 画面规划文档（数量灵活，含时间/论点/视觉形式/文案/设计说明） |
| `XX演讲视觉页面_自动播放.html` | 自动播放+字幕同步+ztEdit 原生动画绑定（双击可录屏，导入 ztEdit 可编辑字幕/绑定/动画/时间轴） |
| `毒教材-合并播放.html`（模板合并模式） | 当存在模板文件时，合并视觉页面与模板 |

---

## 设计系统（v4.0 新增）

### 1. 配色方案

#### 国风默认配色（暖纸感）

| 颜色 | 色值 | 用途 |
|:---|:---|:---|
| 暖米杏色 | `#F5F0E8` | 主背景 |
| 纸白色 | `#FAF6F0` | 卡片背景 |
| 深墨色 | `#2C2C2C` | 正文文字 |
| 赭石枣红 | `#8B3A3A` | 卡片底色、强调标识 |
| 朱红 | `#C41E24` | 标题强调色 |
| 褚红 | `#C23B22` | 印章色 |
| 暗金 | `#B8860B` | 点缀装饰 |
| 浅褐线 | `#D4C9B8` | 分隔线、边框 |

#### 暗黑背景配色

| 颜色 | 色值 | 用途 |
|:---|:---|:---|
| 深炭墨 | `#2C2C2C` | 暗黑页面背景 |
| 纯黑 | `#1a1a1a` | 封面底部渐变 |

### 2. 字体规范

| 用途 | 字体 | CSS |
|:---|:---|:---|
| 标题 | 思源宋体 | `'Noto Serif SC', serif` |
| 正文 | 思源黑体 | `'Noto Sans SC', sans-serif` |
| 印章/装饰 | 楷体→宋体统一 | `'Noto Serif SC', serif` |

> v4.0 统一使用 Noto Serif SC / Noto Sans SC，移除楷体混用

### 3. 页面类型体系 + 容器设计系统

| 类型 | 说明 | CSS类/HTML模式 | 适用场景 |
|:---|:---|:---|:---|
| `slide-cover` | 封面暗黑渐变+拼贴墙+大字标题 | `slide-cover` + `.collage` | 开篇 |
| `slide-dark` | 深色背景+白字+红色强调 | `slide-dark` | 情绪高点、系统追问 |
| `slide` | 暖米色背景+卡片布局 | `slide` | 常规展示 |
| `slide-hero` | 大圆角卡片+左右双栏 | `background:#FAF6F0;border-radius:36px` | 结尾/重点页 |

#### 12种容器类型（移植自 srt-remotion-video 国风设计系统）

| # | 容器 | CSS | 用途 |
|:---|:---|:---|:---|
| 1 | **墨色卡** `ink-card` | `background:#2C2C2C;color:#F5F0E8;padding:24px;border-radius:6px` | 深色区块、数据对比 |
| 2 | **米色卡** `cream-card` | `background:#FAF6F0;border:1px solid #D4C9B8;border-radius:8px;padding:24px` | 内容卡片、引用块 |
| 3 | **印章标签** `seal-stamp` | `background:#C23B22;color:#fff;padding:6px 18px;transform:rotate(-2deg);display:inline-block` | 标识、标签、关键词 |
| 4 | **徽章** `seal-badge` | `border:2px solid #C23B22;padding:6px 14px;display:inline-block` | 序号、小标题 |
| 5 | **纸面区块** `paper-section` | `background:linear-gradient(180deg,#FAF6F0,#F5F0E8);padding:30px;border-radius:8px` | 长文段落 |
| 6 | **卷轴标题** `scroll-title` | `border-left:3px solid #8B3A3A;padding:8px 0 8px 20px` | 章节标题 |
| 7 | **菱形列表** `rhombus-list` | `li::before{content:"◆";color:#8B3A3A;margin-right:10px}` | 项目符号、要点列表 |
| 8 | **暗色面板** `dark-panel` | `background:#2C2C2C;border:1px solid rgba(139,58,58,0.3);border-radius:12px;padding:20px` | 深色模式产品界面 |
| 9 | **书法标签** `calligraphy-tag` | `writing-mode:vertical-rl;font-size:0.8rem;color:#8B3A3A;letter-spacing:0.12em` | 竖排装饰标签 |
| 10 | **圆形序号** `circle-number` | `width:48px;height:48px;border-radius:50%;border:2px solid #8B3A3A;display:flex;align-items:center;justify-content:center` | 步骤编号、圆点标识 |
| 11 | **古典分隔线** `divider-classical` | `height:1px;background:linear-gradient(90deg,transparent,#D4C9B8,transparent)` | 段落分隔 |
| 12 | **引用块** `quote-block` | `border-left:3px solid #8B3A3A;padding:16px 20px;background:rgba(139,58,58,0.06)` | 引文、高亮事实 |

#### 动画编排系统（移植）

| 类名 | 效果 | 参数 |
|:---|:---|:---|
| `.stagger-children` | 子元素逐次交错入场 | `--stagger-delay: var(--stagger-md)`（100ms） |
| `.seq-enter-elegant` | 优雅弹入 | `0.5s cubic-bezier(0.34,1.56,0.64,1) forwards` |
| `.seq-reveal-left` | 从左展开（clip-path） | `0.7s ease-out forwards` |
| `.fade-in-elegant` | 淡入+上移 | `0.5s ease forwards` |
| `.ink-spread` | 墨迹展开（clip-path） | `0.8s ease-out forwards` |
| `.seal-appear` | 印章弹出（缩放入） | `0.5s cubic-bezier(0.34,1.56,0.64,1) forwards` |

交错延迟变量：`--stagger-xs(30ms)` → `--stagger-sm(60ms)` → `--stagger-md(100ms)` → `--stagger-lg(150ms)` → `--stagger-xl(200ms)`

```html
<!-- 使用示例 -->
<div class="stagger-children" style="--stagger-delay: var(--stagger-md);">
  <div>元素1（100ms后出现）</div>
  <div>元素2（200ms后出现）</div>
  <div>元素3（300ms后出现）</div>
</div>
```

### 4. 布局模式

| 模式 | CSS | 适用场景 |
|:---|:---|:---|
| **左文右图** | `display:flex; align-items:center; gap` | 图文并茂 |
| **左右双栏** | `flex:0 0 50%/50%` 或 `flex:1`（自适应） | 对比展示、Hero布局 |
| **居中大字** | `text-align:center; font-size:4-6rem` | 情绪冲击 |
| **网格卡片** | `display:grid; grid-template-columns:repeat(N,1fr)` | 概念分类、多列对比 |
| **流程图** | `display:flex; align-items:center; flex-wrap:wrap` | 流程展示、链条关系 |
| **上下双段** | `height:55%`(暗) + `height:45%`(亮) | 系统说明 |
| **四列网格+圆图标** | `grid-template-columns:repeat(4,1fr)` + `border-radius:50%` | 概念卡片（如白·典·转·问）|

---

## ztEdit 原生格式规范（v5.3，生成 HTML 必须遵循）

> **生成目的与流水线**：本技能生成的 HTML 要同时满足两个用途——①浏览器双击自动播放（录屏成视频）；②导入 ztEdit 可视化编辑器后，能直接看到「字幕↔元素」绑定关系，可改字幕/改绑定/改动画/调时间轴，导出后仍保持效果。
>
> 为此，生成时**必须采用 ztEdit 原生格式**：DOM 字幕 + `data-zt-id` 元素标识 + `data-zt-bound-to` 绑定 + `data-zt-anim-effect` 动画 + `focus-group` 分组。**不再使用** `data-trigger`/`mg-hide`/`mg-pop`/旧 `data-focus`/`zoom-focus` 等旧属性。

### 核心数据模型

| 概念 | 属性/结构 | 说明 |
|:---|:---|:---|
| **DOM 字幕** | `<div data-zt-role="subtitle" data-zt-subtitle-start="REL" data-zt-subtitle-end="REL">文本</div>` | 每个 slide 内放一个 `<div class="slide-subtitles" style="display:none">` 容器，里面是逐条字幕。REL=该字幕绝对时间戳 − 当前 slide 的起始时间（相对秒） |
| **元素标识** | `data-zt-id="el-{slide}-{n}"` | 每个要绑定动画的元素必须有唯一 id，递增命名 |
| **绑定关系** | 字幕元素加 `data-zt-bound-to="[data-zt-id='el-x-y']"` | 写在**字幕**上，指向要触发的元素。一条字幕只能绑一个元素 |
| **动画效果** | `data-zt-anim-effect="focus-zoom"` 等 | 写在**被绑定元素**上。`focus-*` 为强调类（始终可见→放大高亮），其余为入场类（隐藏→出现） |
| **强调分组** | `<div class="focus-group">` 包裹 + 元素加 `class="focus-item"` | 强调类效果需同组联动：触发时目标放大高亮，同组其他元素变暗 |

### 动画效果清单（与 ztEdit 一致）

| 效果名 | 类型 | 视觉 |
|:---|:---|:---|
| `focus-zoom` | **强调**（默认首选） | 元素始终可见，字幕触发时放大1.12倍+发光，同组变暗。聚光灯效果 |
| `zoom-in` | 入场 | 从0.6放大到1.3出现 |
| `fade-in` | 入场 | 淡入出现 |
| `fly-left`/`fly-right`/`fly-top`/`fly-bottom` | 入场 | 从各方向飞入 |
| `bounce` | 入场 | 弹跳出现 |
| `rotate` | 入场 | 旋转出现 |

> **默认用 `focus-zoom`**（强调风格，元素一开始全可见，逐个高亮），与本项目「内容优先展示」原则一致。仅当确实需要元素「从无到有」揭示时才用入场类。

### 完整 slide 骨架示例

```html
<div class="slide" id="s1" style="background:#F5F0E8;">
  <!-- ① DOM 字幕容器（display:none，不显示，供播放/编辑读取） -->
  <div class="slide-subtitles" style="display:none">
    <div data-zt-role="subtitle" data-zt-subtitle-start="0.033" data-zt-subtitle-end="2.300" data-zt-bound-to="[data-zt-id='el-1-0']">人在家中坐，锅从天上来</div>
    <div data-zt-role="subtitle" data-zt-subtitle-start="2.533" data-zt-subtitle-end="4.100">大家好，我是小踏</div>
  </div>

  <!-- ② 可见内容：focus-group 包裹需要联动强调的元素 -->
  <div class="focus-group">
    <div class="focus-item" data-zt-id="el-1-0" data-zt-anim-effect="focus-zoom">五天闹剧</div>
    <div class="focus-item" data-zt-id="el-1-1" data-zt-anim-effect="focus-zoom">7/26 出现帖</div>
  </div>
</div>
```

### 绑定规则（scene-plan → 绑定）

1. 每个 beat 的目标元素：加 `data-zt-id`、加 `data-zt-anim-effect`（默认 focus-zoom）、加 `class="focus-item"`，用 `<div class="focus-group">` 包裹同组元素
2. 该 beat 对应的字幕：加 `data-zt-bound-to="[data-zt-id='...']"` 指向元素
3. **一条字幕只能绑一个元素**；若多个元素要在同一字幕时段强调，把次要元素绑到**相邻未绑定的字幕**（向前/向后找最近的空字幕），保证每个元素都能被触发
4. 不需要动画的字幕/元素：不加绑定属性即可

### 播放脚本（内嵌，ztEdit 风格）

生成时内嵌一段 IIFE 播放脚本（与 ztEdit 导出脚本一致）：
- 保留 `const slideTimings=[...]`（绝对时间）
- 启动时从 DOM `[data-zt-role="subtitle"]` 读取相对时间 + slideTimings 计算，构建 `subtitles[]` 数组（**不再写 `const subtitles` 数组**）
- `loop()` 中遍历当前 slide 的字幕，对有 `data-zt-bound-to` 的字幕：
  - 元素 effect 为 `focus-*` → 到时间点加 `zt-focus-active` 类 + 同组 `dim-others`（持续状态，触发一次）
  - 元素 effect 为入场类 → 到时间点调用 `playAnimation()`（0.5s 窗口内触发一次）
- `showSlide()` 翻页时清除 `animDone`/`focusDone` 标记 + 移除 `zt-focus-active`/`dim-others` 类
- 保留 ← → 方向键/点击翻页/空格启动/自动播放

> 完整播放脚本参见 `模板-唐朝不存在风格-v5.1.html` 的 `<script>` 块（已转为 ztEdit 原生格式，可直接复制结构）。

### 必须包含的 CSS（focus 联动）

```css
.focus-group .focus-item{transition:all .6s ease;position:relative}
.focus-group.dim-others .focus-item{opacity:.35;filter:brightness(.7) blur(1px)}
.focus-group.dim-others .focus-item.zt-focus-active{opacity:1;filter:brightness(1) blur(0);transform:scale(1.12);z-index:3;box-shadow:0 0 50px rgba(196,30,36,.35)}
/* 文字卡片强调变体 */
.focus-group.dim-others .focus-item-text.zt-focus-active{opacity:1;transform:scale(1.06);color:var(--red);font-weight:700}
```

> ⚠️ 激活类统一用 `zt-focus-active`（**不要**用旧的 `zoom-focus`）。

---

## 工作流

### Phase 1: 读取与分析

1. **读取字幕文件**（`.txt` 或 `.srt`）：
   - 解析 SRT 格式时间戳（`00:00:00,133 --> 00:00:01,466`）
   - 提取结构化数据：`{index, startSec, endSec, text}`
   - 字幕质量检查：识别同音字误识别并修正

2. **智能分镜（Storyboard生成）**：
   - 使用 subagent 读取 SRT，根据以下规则将连续字幕自动分组为场景：
     - **语义完整性**：同一主题/论点/例子的字幕归为一组
     - **时长控制**：单场景目标时长 12-18 秒，不超过 25 秒
     - **自然边界**：在语义转折、总结词、引入词处切分
     - **强分组信号**：转折词（但是、然而）、总结词（所以、因此）、引入词（比如、举个例子）
     - **弱分组信号**：连续列举项、同一句话拆成多条字幕、问答对
   - 输出分组计划：`scene-plan/{slide-plan}.json`
     ```json
     {
       "scenes": [
         {
           "id": "scene_001",
           "fromIndex": 1, "toIndex": 3,
           "startSec": 0.0, "endSec": 8.5,
           "semanticTags": ["开场", "介绍"],
           "visualHint": "大标题居中，逐段揭示主题图标"
         }
       ]
     }
     ```
   - 验证连续性：第一组 fromIndex=1，每组首尾衔接覆盖全部字幕

3. **读取素材图片**：
   - 查看每个素材内容，记录关键信息
   - 长图素材（高度>宽度3倍）需裁剪分段：
     - 按语义区域拆分（如上中下三段）
     - 或按比例拆分（如 3:2:2、1:1）
     - 使用 Python PIL 裁剪：`img.crop((0, top, w, bottom))`
     - 拆分段保存为 `{name}-part-{N}.png`
   - 标注每段素材对应的画面和子标题

4. **TTS语音生成**（无音频文件时）：
   - 使用 `python -m edge_tts --file {srt} --voice zh-CN-YunxiNeural --write-media {output}.mp3`
   - 支持的声音：`zh-CN-YunxiNeural`(男)、`zh-CN-YunjianNeural`(男·激情)、`zh-CN-XiaoxiaoNeural`(女·温暖)

### Phase 2: 文案规划

1. **分析演讲结构**：根据字幕划分段落（4-6段），识别核心论点

2. **规划画面**（数量灵活，约15-22个）：

   | 类型 | 说明 |
   |:---|:---|
   | 封面（拼贴墙） | 多张素材旋转拼贴+大字标题+红色光晕 |
   | 案例展示 | 图文并茂，图片截断只显示关键区域 |
   | 证据罗列 | 多段拆分图横向并列+MG弹入 |
   | 概念说明 | 左文右图/左图右文+赭红分隔线 |
   | 流程展示 | 横向流程图+节点依次弹入 |
   | 对比分析 | 多列对比+聚焦/模糊效果 |
   | 情绪高点 | 暗黑背景+大字+红色强调 |
   | 系统说明 | 上下双段（暗+亮）+概念卡片 |
   | 审核链条 | 左流程图+右图 |
   | Hero结尾 | 大圆角卡片+左右双栏+一键三连 |

3. **每个画面需包含**：
   - 时间范围（秒）
   - 核心论点
   - 视觉形式
   - 页面文案
   - MG动画触发时间

### Phase 2.5: 场景规划（Scene-Plan 生成）

在 Phase 2 文案规划完成后，将文案转化为结构化 scene-plan，作为 Phase 3 HTML 生成的唯一输入源。

#### 场景规划 JSON 结构

每个画面输出一份 scene-plan：

```json
{
  "sceneId": "scene_005",
  "startTime": 55.5,
  "duration": 12.3,
  "goal": "对比三个朝代漫画封面的标题措辞，揭示褒贬倾向",
  "layout": "horizontal-flow",
  "visualCore": "三册漫画封面横向并排，中间箭头串联",
  "surface": "cream-card",
  "emphasis": "副标题文字对比",
  "screenShouldShow": [
    "元朝「纵横驰骋」（红色强调）",
    "明朝「啼笑皆非」（红色强调+讽刺）",
    "清朝「傲视天下」（蓝色强调）",
    "底部结论：这不是历史教育"
  ],
  "beatPlan": [
    {"segments": [0], "action": "三张封面横向对比展示"},
    {"segments": [1], "action": "元标题高亮"},
    {"segments": [2], "action": "明标题高亮","highlight":"#8B3A3A"},
    {"segments": [3], "action": "清标题高亮"},
    {"segments": [4], "action": "结论淡入"}
  ]
}
```

#### 字段说明

| 字段 | 说明 | 取值来源 |
|:---|:---|:---|
| `sceneId` | 场景编号 | 递增 `scene_001` |
| `startTime/duration` | 时间（秒） | Phase 1 智能分镜 |
| `goal` | 核心信息 | Phase 2 文案 |
| `layout` | 布局模式 | 从布局模式表选取 |
| `visualCore` | 主视觉 | 素材/图形描述 |
| `surface` | 容器类型 | 从12种容器选取 |
| `emphasis` | 强调什么 | 文字/数字/对比 |
| `screenShouldShow[]` | 画面上显示的元素 | 从文案提炼 |
| `beatPlan[]` | 节奏规划 | `segments`索引+动作 |

#### 布局→容器 速查矩阵

| 布局 | 推荐容器 | 典型MG |
|:---|:---|:---|
| 封面 | `slide-cover` + 拼贴墙 | 素材旋转飞入 |
| 左文右图 | `slide` + `quote-block`(左) | 图片淡入 |
| 证据并列 | `slide` + `cream-card`(多个) | focus-zoom 逐个高亮 |
| 流程 | `slide` + `ink-card`(节点) | 节点+箭头 MG 依次 |
| 概念分类 | `slide` + `circle-number` | 网格内 stagger 入场 |
| 暗黑情绪 | `slide-dark` + 居中大字 | 红色大字 fadeIn |
| Hero结尾 | `slide-hero` + `dark-panel`(右) | 标签+CTA弹入 |
| 系统说明 | 上下段 ink-card + cream-card | 上段网格+下段大字 |

### Phase 3: 模板化自动播放架构（scene-plan 驱动）

采用 **scene-plan → HTML生成 → 模板合并** 流水线。每个画面由 scene-plan 驱动，不再手工编写 HTML。

```
scene-plan.json（结构化规划）
    │
    ▼
HTML生成器（根据 layout + surface + beatPlan 生成滑页HTML）
    │
    ▼
合并到 自动播放-模版.html（CSS+JS引擎）
    │
    ▼
最终输出：XX演讲视觉页面_自动播放.html
```

#### 生成规则

从 scene-plan 生成 HTML 的原则：

1. `layout` 决定外层 flex/grid 容器
2. `surface` 决定容器样式（从12种容器选取对应CSS）
3. `visualCore` + `screenShouldShow` 决定内容元素
4. `beatPlan` 决定每个元素的 `data-zt-anim-effect` + 字幕 `data-zt-bound-to` 绑定（详见「ztEdit 原生格式规范」）
5. `emphasis` 决定高亮/聚焦元素的样式
6. 强调元素用 `<div class="focus-group">` 包裹 + `class="focus-item"` + `data-zt-anim-effect="focus-zoom"`，并加 `data-zt-id` 供字幕绑定

```html
<!-- 生成示例：从 scene-plan 到 HTML（ztEdit 原生格式） -->
<!-- layout: horizontal-flow + surface: cream-card -->
<div class="slide" id="s4" style="background:#F5F0E8;">
  <!-- DOM 字幕（相对时间，display:none 不显示） -->
  <div class="slide-subtitles" style="display:none">
    <div data-zt-role="subtitle" data-zt-subtitle-start="0.0" data-zt-subtitle-end="3.0" data-zt-bound-to="[data-zt-id='el-4-0']">三个朝代，三种态度</div>
    <div data-zt-role="subtitle" data-zt-subtitle-start="3.5" data-zt-subtitle-end="6.0" data-zt-bound-to="[data-zt-id='el-4-1']">元朝纵横驰骋</div>
  </div>
  <div class="slide-content" style="text-align:center;">
    <div class="focus-group">
      <div class="slide-title focus-item" data-zt-id="el-4-0" data-zt-anim-effect="focus-zoom">三个朝代，三种态度</div>
      <div class="flow-node focus-item" data-zt-id="el-4-1" data-zt-anim-effect="focus-zoom">📘 元朝</div>
    </div>
  </div>
</div>
```

#### 验证

生成HTML后验证：
- 每个滑页有唯一 `id="s{N}"`
- `slideTimings` 数组覆盖全部滑页
- 每个 slide 内有 `<div class="slide-subtitles">` 含全部 DOM 字幕（`data-zt-role` + 相对时间戳）
- 有动画的元素都有 `data-zt-id` + `data-zt-anim-effect`，对应字幕有 `data-zt-bound-to` 指向它
- 强调类（focus-*）元素都在 `focus-group` 内且有 `focus-item` 类
- 素材图片路径指向存在的文件
- 音频文件路径有效

---

### Phase 3B: 模板结构参考

```
自动播放-模版.html（基础设施）
    ├── CSS 设计系统（配色/字体/布局/进度条/字幕）
    ├── 封面拼贴墙（素材旋转飞入动画）
    ├── 左上角标题 + 右上角头像
    ├── 音频元素 + 进度条
    ├── 影视级字幕（底部单句+多层text-shadow）
    ├── JavaScript 自动播放引擎
    │   ├── slideTimings 滑页-时间映射
    │   ├── subtitles[] 字幕数组
    │   ├── requestAnimationFrame 循环
    │   ├── ← → 方向键 + 点击翻页
    │   └── 翻页时音频跳转+字幕同步
    └── 星光粒子 + 古风人物线描

视觉页面（毒教材演讲视觉页面_自动播放.html）
    ├── 各滑页HTML内容
    ├── 内联CSS样式（每页独立设计）
    └── 素材图片引用

合并播放（毒教材-合并播放.html）
    └── 模板框架 + 视觉页面内容 = 最终产物
```

#### 合并流程

1. 读取模板文件（`自动播放-模版.html`），提取CSS框架和JS引擎
2. 读取视觉页面文件，提取各滑页HTML
3. 替换模板中的滑页内容
4. 更新字幕数组（`const subtitles = [...]`）
5. 更新音频路径
6. 更新标题/头像/装饰
7. 保存为合并播放HTML

### Phase 4: 动画与绑定引擎（v5.3，ztEdit 原生）

> 完全采用 ztEdit 原生格式，详见「ztEdit 原生格式规范」。不再使用 `data-trigger`/`mg-hide`/`mg-pop` 等旧属性。

#### 字幕→元素绑定触发

动画通过**字幕绑定**触发，而非元素自带时间戳：
- 元素加 `data-zt-id` + `data-zt-anim-effect`（写在被绑元素上）
- 对应字幕加 `data-zt-bound-to="[data-zt-id='...']"`（写在字幕上）
- 播放脚本 `loop()` 遍历当前 slide 字幕，到时间点触发绑定元素的动画

```html
<!-- 字幕（display:none 容器内） -->
<div data-zt-role="subtitle" data-zt-subtitle-start="2.5" data-zt-subtitle-end="5.0"
     data-zt-bound-to="[data-zt-id='el-2-0']">看这张图</div>
<!-- 被绑元素 -->
<div class="focus-item" data-zt-id="el-2-0" data-zt-anim-effect="focus-zoom">关键证据</div>
```

#### 效果类型

| 效果 | 类型 | 触发方式 |
|:---|:---|:---|
| `focus-zoom`（默认首选） | 强调 | 加 `zt-focus-active` 类 + 同组 `dim-others`，持续状态，触发一次 |
| `zoom-in`/`fade-in`/`fly-*`/`bounce`/`rotate` | 入场 | 调用 `playAnimation()` 关键帧动画，0.5s 窗口内触发一次 |

> 强调类元素必须放在 `<div class="focus-group">` 内并加 `class="focus-item"`，实现「目标放大高亮 + 同组变暗」联动。

#### 图片拆分动效

图片分段（字典/书籍/评论等）改用 `focus-zoom` 绑定：每段图片加 `data-zt-id` + `focus-item` + `focus-zoom`，放在同一 `focus-group` 内，各自绑到对应字幕。字幕播到时该段放大高亮、其余段变暗。

#### 播放脚本核心逻辑

```javascript
// loop() 中遍历当前 slide 的字幕
cur.querySelectorAll('[data-zt-role="subtitle"]').forEach(function(subEl){
  var boundSel=subEl.getAttribute('data-zt-bound-to');
  if(!boundSel)return;
  var boundEl=document.querySelector(boundSel); if(!boundEl)return;
  var effect=boundEl.getAttribute('data-zt-anim-effect')||'';
  var absStart=slideStart+parseFloat(subEl.getAttribute('data-zt-subtitle-start'));
  if(effect.indexOf('focus-')===0){            // 强调：持续状态
    if(!boundEl.dataset.focusDone && t>=absStart){
      boundEl.dataset.focusDone='1';
      var grp=boundEl.closest('.focus-group');
      if(grp)grp.classList.add('dim-others');
      boundEl.classList.add('zt-focus-active');
    }
  }else{                                        // 入场：关键帧动画
    if(!boundEl.dataset.animDone && t>=absStart && t<absStart+0.5){
      boundEl.dataset.animDone='1';
      playAnimation(boundEl,effect,...);
    }
  }
});
// showSlide() 翻页时清除 animDone/focusDone + 移除 zt-focus-active/dim-others
```

### Phase 5: 聚焦强调效果（v5.3，ztEdit 原生 focus-zoom）

> 替代旧的 `data-focus`/`m5-focus`/`m5-blur` 方案。现在统一用 `focus-zoom` 效果 + `focus-group` 分组，由字幕绑定触发，导入 ztEdit 后可编辑绑定关系与动画。

```css
.focus-group .focus-item{transition:all .6s ease;position:relative}
.focus-group.dim-others .focus-item{opacity:.35;filter:brightness(.7) blur(1px)}
.focus-group.dim-others .focus-item.zt-focus-active{opacity:1;filter:brightness(1) blur(0);
  transform:scale(1.12);z-index:3;box-shadow:0 0 50px rgba(196,30,36,.35)}
```

```html
<div class="focus-group">
  <img class="focus-item mat-img" data-zt-id="el-3-0" data-zt-anim-effect="focus-zoom" src="证据1.jpg">
  <img class="focus-item mat-img" data-zt-id="el-3-1" data-zt-anim-effect="focus-zoom" src="证据2.jpg">
</div>
<!-- 字幕分别绑到 el-3-0 / el-3-1，播到时对应图放大高亮、另一张变暗 -->
```

> ⚠️ 激活类用 `zt-focus-active`（不要用旧 `zoom-focus`）。多张图聚焦时各自绑不同字幕，避免一条字幕绑多个元素。

### Phase 5B: 印章/徽章设计（v4.0 新增）

#### 圆形印章

```html
<div style="width:64px;height:64px;border-radius:50%;background:#C23B22;
    display:flex;align-items:center;justify-content:center;
    transform:rotate(-12deg);">
    <span style="color:#fff;font-weight:700;font-size:0.85rem;">印章文字</span>
</div>
```

#### 盾形徽章（clip-path）

```css
clip-path: polygon(0% 8%, 8% 0%, 92% 0%, 100% 8%, 100% 78%, 
    82% 100%, 50% 92%, 18% 100%, 0% 78%);
```

### Phase 6: 新中式Hero布局（v4.0 新增）

用于结尾/重点页，大圆角卡片+左右双栏：

```html
<div class="slide" style="background:#F5F0E8;">
    <div style="background:#FAF6F0;border-radius:36px;padding:50px 60px;
        display:flex;gap:30px;max-width:1300px;box-shadow:0 4px 20px rgba(0,0,0,0.04);">
        <!-- 左侧：文案信息区（竖排题签+标题+说明+场景标签+CTA按钮） -->
        <!-- 右侧：产品界面演示区（深色卡片+视频播放+状态指示器） -->
    </div>
</div>
```

### Phase 7: 页面类型速查表

| 页面 | 样式标准 | 典型动画 |
|:---|:---|:---|
| 封面 | `slide-cover` + 拼贴墙 + `burst` 光晕 | 拼贴飞入 flyIn |
| 图文展示 | 左文右图 flex + 暖米色底 | 图片淡入 |
| 分段展示 | 多个 div 横向并排 | focus-zoom 逐个高亮 |
| 流程展示 | flow-chart + flow-node | 节点+箭头依次MG |
| 暗黑情绪 | slide-dark | 大字红色强调 |
| 国风卡片 | 暖米底+赭红卡片+宋体标题 | 卡片淡入 |
| Hero结尾 | 大圆角#FAF6F0卡片+50/50分栏 | 标签+CTA弹入 |

### Phase 8: 验证与交付

1. 所有文件在同一目录
2. 双击HTML自动播放，字幕同步
3. ← → 方向键切换画面（音频跳转）
4. 点击右半屏前进/左半屏后退
5. MG动画在每次进入滑页时重置重播

## 关键参数速查

### 布局参数

| 参数 | 默认值 | 说明 |
|:---|:---|:---|
| 卡片圆角 | `36px` | Hero卡片 |
| 常规圆角 | `12px` | 图片/普通卡片 |
| 左右间距 | `gap:20-60px` | flex容器 |
| 卡片内边距 | `padding:40-60px` | 根据内容密度 |
| 图片圆角 | `8-12px` | 统一 |
| 图片阴影 | `0 8px 24-30px rgba(0,0,0,0.15-0.2)` | 轻阴影 |

### 字幕CSS参数（单句简约风格）

| 参数 | 值 |
|:---|:---|
| 字号 | 2.8rem |
| 颜色 | #ffffff |
| 字重 | 700 |
| text-shadow | 4层：黑(6px)→黑(18px)→黑(40px)→金(60px) |
| 背景 | 无 |
| 切换动画 | 350ms cubic-bezier(0.25,0.46,0.45,0.94) |

### 字幕切分与标点规则（用户多轮强调）

1. **字幕不要太长**：单条字幕建议 ≤ 16 个汉字。长句在逗号（或语义停顿）处拆分为下一条字幕显示，拆开后保证每条语义完整可读。
2. **去掉句末标点**：当前字幕最后一个标点符号要去掉（如句号 。、逗号 ，、顿号 、、分号 ；、冒号 ： 等收尾标点），避免与字幕切换动画叠加显得拖沓。
3. **保留强调性标点**：叹号 ！、问号 ？、引号 ""『』「」、书名号 《》〈〉、省略号 …… 等承载语气/引用信息的标点必须保留（口播稿中的强调句、引用句不能去标点）。
4. 应用范围：SRT 字幕、HTML 页面字幕数组（subtitles[]）、视觉页面上单独展示的字幕文案，三处统一执行该规则。

### 翻页控制

| 操作 | 功能 |
|:---|:---|
| → 键 / 点击右半屏 | 前进 + 音频跳转 |
| ← 键 / 点击左半屏 | 后退 + 音频跳转 |
| 空格键 | 首次启动播放 |
| 手动翻页后 | 暂停3秒自动同步 |

### Edge-TTS 语音生成

```bash
python -m edge_tts --file {字幕文件} --voice zh-CN-YunxiNeural --write-media {输出}.mp3
```

常用中文声音：
- `zh-CN-YunxiNeural` - 男声·阳光
- `zh-CN-YunjianNeural` - 男声·激情
- `zh-CN-XiaoxiaoNeural` - 女声·温暖

---

## 常见修改场景

### 图片拆分+MG动效

1. PIL裁剪图片为N段
2. 每段加 `data-zt-id` + `class="focus-item"` + `data-zt-anim-effect="focus-zoom"`，包在 `<div class="focus-group">` 内
3. 每段绑到对应字幕（`data-zt-bound-to`），播放时该段放大高亮、其余变暗
4. `showSlide()` 中重置 `zt-focus-active`/`dim-others` 状态

### 添加字幕聚焦效果

1. 给每张图片添加 `.m5-part` 类
2. 定义 `.m5-part.m5-focus`（scale 1.3）和 `.m5-part.m5-blur`（brightness 0.5）
3. `loop()` 中按 `audio.currentTime` 切换聚焦

### 更换图片为圆形印章

```html
<div style="width:64px;height:64px;border-radius:50%;background:#C23B22;
    transform:rotate(-12deg);display:flex;align-items:center;justify-content:center;">
    <span style="color:#fff;font-size:0.85rem;">印章文字</span>
</div>
```

### 整页应用统一字体

全局只使用 `'Noto Serif SC', serif`（标题/装饰）和 `'Noto Sans SC', sans-serif`（正文），移除楷体混用。

### 调整图片显示区域

```html
<!-- 仅保留底部3/5 -->
<img style="object-fit:contain; width:auto; height:auto; max-height:52vh;">
```

### 翻页自动跳转音频+字幕同步

修改 `showSlide(idx, seekAudio)` 函数，当 `seekAudio` 为 `true` 时：
```javascript
var st = slideTimings.find(t => t.slide === idx);
if (st) audio.currentTime = st.start;
```

## 实战经验（v5.1 新增，基于"唐朝不存在"项目多轮迭代）

### 封面拼贴动画：分批飞入

不要所有图片逐一散落（animation-delay 逐个递增），改为**分批次同时飞入**：

| 批次 | 图片组 | 典型延迟 | 效果 |
|:---|:---|:---|:---|
| 第一批 | 四角主图 (c1-c4) | 0.5s | 框架先到位 |
| 第二批 | 四边填充 (c5-c8) | 3.5s | 画面逐渐丰富 |
| 第三批 | 中间装饰 (c9-c12) | 7s | 收束完成 |

```css
/* 同一批次的图片共用相同 animation-delay */
.collage .c1,.c2,.c3,.c4 { animation-delay: .5s; }
.collage .c5,.c6,.c7,.c8 { animation-delay: 3.5s; }
.collage .c9,.c10,.c11,.c12 { animation-delay: 7s; }
```

> 原则：animation-delay 总和 + 动画时长 ≈ 封面停留总时长，最后一批完成后留 2-3 秒给观众看全貌

### 内容优先展示（ztEdit 原生 focus-zoom）

v4.0 的 `mg-hide → mg-pop` 模式已废弃。现在统一用 **ztEdit 原生 focus-zoom**：所有内容一开始就可见，字幕触发时通过 `zt-focus-active` 类放大高亮、同组 `dim-others` 变暗。

```css
.focus-group .focus-item { transition: all .6s ease; position:relative; }
.focus-group.dim-others .focus-item { opacity: .35; filter: brightness(.7) blur(1px); }
.focus-group.dim-others .focus-item.zt-focus-active {
    opacity: 1; filter: brightness(1) blur(0);
    transform: scale(1.12); z-index: 3;
    box-shadow: 0 0 50px rgba(196,30,36,.35);
}
```

```html
<!-- ztEdit 原生：元素始终可见，字幕绑定触发高亮 -->
<div class="focus-group">
    <div class="tl-node focus-item" data-zt-id="el-1-0" data-zt-anim-effect="focus-zoom">7/26</div>
    <div class="tl-node focus-item" data-zt-id="el-1-1" data-zt-anim-effect="focus-zoom">7/27</div>
</div>
<!-- 对应字幕：data-zt-bound-to="[data-zt-id='el-1-0']" 等 -->
```

> 切换滑页时 `showSlide()` 中必须重置所有 `dim-others` 和 `zt-focus-active`。导入 ztEdit 后可改绑定/改动画/调时间轴。

### 默认布局：左文右图

内容页**首选左右布局**（`.lr-row`），居中大字仅用于暗黑情绪页。

```css
.lr-row { display:flex; gap:30px; align-items:center; width:100%; max-width:1300px; }
.lr-left, .lr-right { flex:1; min-width:0; }
```

| 页面类型 | 布局 | 示例 |
|:---|:---|:---|
| 内容展示 | `.lr-row` 左文右图（或左图右文） | 文章分析、证据展示 |
| 情绪高潮 | `slide-dark` + 居中大字 | "从头到尾，不存在" |
| 暗黑流程 | `.lr-row` + 左流程右图 | 批判三步操作 |

### 图片显示规则

1. **不裁剪**：`object-fit:contain`，完整显示整张图
2. **无白框**：不要给 `.mat-img` 加 `background:#fff` 和 `width:100%`，用 `max-width:100%` 让容器跟着图片尺寸走
3. **多图等高**：同一行多张图使用 `.img-row`（`display:flex; gap`），不设不同高度
4. **幻灯片 padding 收紧**：`padding:40px` 而不是 `60px 70px`，给内容更多空间
5. **⚠️ `.lr-right` 默认纵向**：CSS 中 `.lr-right` 默认为 `flex-direction:column`，需要横排图片时，要么用 `.img-row` 包裹，要么 inline 显式设置 `flex-direction:row`

```css
.mat-img { max-width:100%; max-height:45vh; object-fit:contain; border-radius:12px; }
.img-row { display:flex; gap:12px; justify-content:center; }
.img-row img { max-height:40vh; object-fit:contain; }
```

### 时间线与滚动条

时间线节点不要用 `overflow-x:auto`（会产生滚动条，观众无法交互）。
用 `flex-wrap:wrap; justify-content:center` 让节点自动换行。

```css
.tl-row { display:flex; gap:8px; flex-wrap:wrap; justify-content:center; }
.tl-node { min-width:100px; font-size:.78rem; }
```

### 封面切页时机

`slideTimings[0].end` 应对齐一句具体的台词（如"人在家中坐，锅从天上来"），
而不是随意设置秒数。从字幕数组中查找目标台词的时间戳。

### 字幕合并

两条相邻短字幕（如"这么多伪史论" + "哪个不是皇汉群体先制造出来!"），
如果间隔 < 0.5s 且语义连贯，合并为一条显示，避免字幕闪烁。

### 封面底部文字

默认不加底部系列名（如"小踏 · 互联网反智事件系列"），保持封面干净。
仅保留主标题 + 副标题。

---

## 实战经验（v5.2 新增，基于"封建王朝一样烂"项目）

### 开场设计：参考图驱动 + 胶片轮播（可替代默认封面拼贴）

用户提供参考图时，先用视觉模型解析构图（分几排/倾斜角度/是否出血/中央标题），再按图实现，不要硬套默认封面。

**胶片轮播开场规范**：
- 整屏无缝拼接：画格左右、上下全部贴紧（flex 无 gap、去边框），画墙比视口大一圈并整体旋转，铺满整屏
- 倾斜角度默认 20°（30° 视觉过陡），统一"左低右高"（CSS `rotate(-20deg)`）；画格内不要再贴朝代/文字标签
- 画格要大：建议 480×270 起，一行可见 4-5 格
- 滚动要交错：各行方向交替（`animation-direction:reverse`）、速度不同、负 delay 错开相位，不要整墙同一方向齐滚
- 无缝循环不露底：每行放 3 组画面（副本），动画区间围绕中心窗口（如 `translateX -960px ↔ 960px`）；2 组会在部分相位露底
- 视频行加 `poster`（抽帧图），避免加载/解码前出现黑格；暗素材先提亮（ffmpeg `eq=brightness=0.22:contrast=1.06`）再抽帧，避免黑块
- 素材抽帧前用视觉模型审查：内容是否代表主题、是否横屏、有无水印/标题卡；带大标题/片名的帧不要入墙

**开场时序与蒙版**：
- 0-2 秒：纯胶片蒙太奇（无文字）
- 2 秒起：半透明蒙版淡入（中央留明、四周压暗 + 轻微 blur），文字在蒙版中央按配音逐句加载
- 蒙版中央可用实底奶油卡片或"中央透明带"承接文字，避免文字直接压杂乱胶片；同时要防止"透出胶片"和"泛白洗底"

### 文字 MG 多样化（去掉图标后不单调）

图标（emoji）可以去掉，但每句文字要有不同字体层级/装饰，避免千篇一律：
- 首句：大号粗体 + 下方金色渐变饰线
- 中段句：暖棕色 + 两侧金色破折号
- 短评句：圆角胶囊标签（浅底 + 描边）
- 重音句：朱红粗体 + 红色饰线
- 落版标题：副标题上方加金色分隔线
- 原则：同一页文字按"信息层级"设计，不要所有句子同一字号同一颜色

### 动画总原则（用户强调）

- 页面加载后所有元素直接显现，不做"隐藏→弹出"；用 `focus-zoom`（字幕绑定触发）实现"放大 + 发光闪现"凸显（详见 ztEdit 原生格式规范）
- 开场可以整段重构（文字MG+图标叙述 → 胶片轮播），以"参考图/口播方案"为准，不要局限于默认模板

### 配色与风格统一

- 开场背景不要深色，也不要大面积明黄：直接沿用正文页背景（如 `#F5F0E8` 暖米色），保持全片色调统一
- 避免过曝泛白：光晕/白雾要克制（蒙版中央留明即可，气泡外发光 ≤ 18px）
- 用户说"不要深色"时，暗色参考图也要改成明快配色实现

### 布局与图片规范（用户多轮强调）

- 图片外框贴合图片大小：`width:fit-content; max-width:100%`，不要大背景板
- 图片完整显示不截断；封面拼贴不裁切
- 文字与图片整体居中、同一水平线；文字框不要倾斜
- 多图：水平并排 + 明确 `gap`（如 22px），宽度一致（竖长截图用相同 max-height）
- 视频作为主视觉时：放宽右列（如 66%）、缩小左右 gap（≤ 26px），让视频贴近文字
- Hero/结尾页：卡片 `max-width` 收紧（约 1000-1010px）、左右 `gap` 26px、左右 flex 接近平衡，避免左右离太远

### 素材版权与准备

- B站等平台下载素材带水印/版权，仅建议草稿演示；正式发布前替换为用户自备或授权素材
- 素材流程：下载片段（720p 横屏 32s 左右）→ 压缩成轻量循环片段（640×360）→ 抽帧（每源 3 格 480×270）→ 视觉模型审查后入墙
- 用户手动新增/修改素材后：先同步用户当前文件，再在其基础上改，保留用户编辑

### 文案修改的联动更新

删除/修改口播文案后必须同步更新：HTML（DOM 字幕 data-zt-subtitle-start/end + data-zt-bound-to 绑定 + slideTimings）、音频（ffmpeg 拼接）、SRT 字幕、口播文稿，四者保持一致。

### 渲染与验收流程（本项目固化）

1. 用 headless Chrome 截图：`--window-size=1920,1080`，每页取代表时间点，`?s=N&clean=1&t=xx`
2. 视觉模型逐张审查（布局/文字可读/缝隙/黑块/标签），迭代到通过
3. 通过后写回原始 HTML + outputs 副本，并重新生成"全部页面预览.png"（12 页 4×3 拼图）
4. 环境踩坑备忘：
   - Chrome 截图需提权；`Start-Process` 前清理重复的 Path/PATH 环境变量
   - apply_patch 偶发失败时改用新文件重建
   - PowerShell 管道传中文给 python 会乱码：中文内容改用 unicode 转义或 apply_patch 写文件
   - 渲染副本要把相对素材路径转 file:// 绝对路径（JS 动态拼接的路径也要替换）


## 版本历史

- v1.0: 初始版本，字幕同步、影视级字幕、自动播放
- v2.0: 基于"历史不会忘记"迭代
- v3.0-v3.4: 基于多个项目迭代
- v4.0: 基于"毒教材泛滥成灾"项目重写
  - 国风设计系统/MG动画引擎/图片拆分动效/聚焦效果/印章/Hero布局/TTS集成
- v5.0: 集成 srt-remotion-video 智能分镜与视觉设计能力
  - 新增：智能分镜协议——SRT语义分组（12-18秒/场景）+ groups.json/storyboard.json
  - 新增：12种容器类型（从cartoon-ui-style-guide移植）含动画编排系统
  - 新增：scene-plan JSON结构——goal/layout/visualCore/surface/beatPlan
  - 新增：布局→容器速查矩阵（8种布局×推荐容器×典型MG）
  - 新增：scene-plan → HTML生成流水线（代替纯手工编写）
  - 新增：生成验证环节（id唯一性/timings覆盖/素材路径/音频路径）
  - 新增：stagger-children 交错入场系统 + 6种编排动画
- v5.2: 基于"封建王朝一样烂"项目更新
  - 新增：参考图驱动开场（胶片轮播：整屏无缝拼接/20°斜向/交错滚动/蒙版+中央文字）
  - 新增：文字 MG 多样化规范（金色饰线/暖色破折号/胶囊标签/红色重音/金色分隔线）
  - 新增：动画总原则（元素直接显现 + 放大闪现凸显）
  - 新增：配色统一原则（开场沿用正文暖米色，勿用深色/大面积明黄）
  - 新增：布局与图片规范补充（外框贴合/多图间隔/视频放大/Hero间距）
  - 新增：素材版权与抽帧审查流程
  - 新增：文案修改四联动（HTML/音频/SRT/文稿）
  - 新增：渲染与视觉验收流程 + 环境踩坑备忘
- v5.1: 基于"唐朝不存在"项目多轮迭代更新
  - 新增：分批飞入封面动画（替代逐一散落）
  - 新增：内容优先聚焦系统（data-focus + zoom-focus，替代 mg-hide）
  - 新增：左文右图默认布局规范（.lr-row）
  - 新增：图片显示规则（不裁剪/无白框/多图等高）
  - 新增：时间线换行方案（flex-wrap 替代 overflow-x:auto）
  - 新增：封面切页时机原则（对齐具体台词）
  - 新增：短字幕合并规则
  - 新增：封面底部精简建议
- v5.3: ztEdit 原生格式对齐（本次更新）
  - 新增：ztEdit 原生格式规范章节——DOM 字幕(data-zt-role+相对时间) + data-zt-id + data-zt-bound-to 绑定 + data-zt-anim-effect 动画 + focus-group 分组
  - 改造：动画模型从 data-trigger/mg-hide/data-focus 统一迁移到 ztEdit 原生（focus-zoom 强调为默认，入场类为辅）
  - 改造：Phase 3/4/5 生成规则、示例、验证全面改为 ztEdit 原生格式
  - 改造：播放脚本内嵌 ztEdit 风格（从 DOM 字幕构建 subtitles[]，字幕绑定触发动画）
  - 改造：激活类统一为 zt-focus-active（废弃 zoom-focus）
  - 同步：参考模板 `模板-唐朝不存在风格-v5.1.html` 已转为 ztEdit 原生格式（161 字幕→DOM，52 元素→focus-zoom 绑定）
  - 目的：生成的 HTML 双击可录屏播放，导入 ztEdit 可改字幕/绑定/动画/时间轴
