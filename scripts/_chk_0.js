` 块（已转为 ztEdit 原生格式，可直接复制结构）。

### 必须包含的 CSS（focus 联动）

```css
.focus-group .focus-item{transition:all .6s ease;position:relative}
.focus-group.dim-others .focus-item{opacity:.35;filter:brightness(.7) blur(1px)}
.focus-group.dim-others .focus-item.zt-focus-active{opacity:1;filter:brightness(1) blur(0);transform:scale(1.12);z-index:3;box-shadow:0 0 50px rgba(196,30,36,.35)}
/* 文字卡片强调变体 */
.focus-group.dim-others .focus-item-text.zt-focus-active{opacity:1;transform:scale(1.06);color:var(--red);font-weight:700}
.zt-hl-sweep{position:relative}
.zt-hl-sweep::after{content:"";position:absolute;left:0;bottom:-0.18em;height:0.12em;width:100%;background:linear-gradient(90deg,#C41E24,#B8860B);border-radius:2px;transform:scaleX(0);transform-origin:left center;transition:transform .6s cubic-bezier(.25,.46,.45,.94);pointer-events:none}
.zt-hl-sweep.zt-hl-active::after{transform:scaleX(1)}
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
| `highlight-sweep` | 强调 | 加 `zt-hl-sweep` 基类 + 触发时 `zt-hl-active` 类，划线扫出，持续状态；不 dim 同组 |
| `zoom-in`/`fade-in`/`fly-*`/`bounce`/`rotate` | 入场 | 调用 `playAnimation()` 关键帧动画，0.5s 窗口内触发一次 |
| `wipe`/`flip`/`blur-in`/`slide-spin` | 入场（v5.4） | 同上；`wipe` 用 clipPath、`blur-in` 用 filter 关键帧属性（脚本帧构建需透传这两个属性） |

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

#### 最小可复用播放脚本模板

下面是一段可直接嵌入 HTML 的完整播放脚本（ztEdit 原生格式），行为与 `模板-唐朝不存在风格-v5.1.html` 一致。生成新页面时应以此为基础，避免自行简化导致切页/动画行为不一致。

```html
<script>
(function(){
  const audio = document.getElementById('bgAudio');
  const slides = document.querySelectorAll('.slide');
  const subtitleEl = document.getElementById('subtitleCurrent');
  const progressBar = document.getElementById('progressBar');
  let currentSlide = 0, currentSubtitle = -1, isPlaying = false, manualOverrideUntil = 0;

  // 构建全局 subtitles 数组（从 DOM 字幕 + slideTimings 计算绝对时间）
  const subtitles = [];
  slides.forEach(function(sl, si){
    const st = slideTimings[si]; if(!st) return;
    sl.querySelectorAll('[data-zt-role="subtitle"]').forEach(function(el){
      const rStart = parseFloat(el.getAttribute('data-zt-subtitle-start')) || 0;
      const rEnd = parseFloat(el.getAttribute('data-zt-subtitle-end')) || 0;
      subtitles.push({ startSec: st.start + rStart, endSec: st.start + rEnd, text: el.textContent });
    });
  });

  function showSlide(idx, seekAudio){
    slides.forEach(function(s, i){ s.classList.toggle('active', i === idx); });
    currentSlide = idx;
    // 翻页时重置本页 focus 状态，保证每次进入都能重播强调动画
    document.querySelectorAll('.focus-item').forEach(function(el){
      delete el.dataset.animDone; delete el.dataset.focusDone;
      el.classList.remove('zt-focus-active', 'zt-hl-active', 'zt-hl-sweep');
    });
    document.querySelectorAll('.focus-group').forEach(function(g){ g.classList.remove('dim-others'); });
    // 只有在已播放状态下才同步音频时间
    if(seekAudio && isPlaying && audio){
      const st = slideTimings.find(function(t){ return t.slide === idx; });
      if(st) audio.currentTime = st.start;
    }
  }

  function updateSubtitle(time){
    let ns = -1;
    for(let i = 0; i < subtitles.length; i++){
      if(time >= subtitles[i].startSec && time < subtitles[i].endSec){ ns = i; break; }
    }
    if(ns !== currentSubtitle && ns !== -1){
      subtitleEl.classList.add('is-changing');
      setTimeout(function(){ subtitleEl.textContent = subtitles[ns].text; subtitleEl.classList.remove('is-changing'); }, 350);
      currentSubtitle = ns;
    }
  }

  function updateSlide(time){
    if(Date.now() < manualOverrideUntil) return;
    for(let i = slideTimings.length - 1; i >= 0; i--){
      if(time >= slideTimings[i].start){
        if(currentSlide !== slideTimings[i].slide) showSlide(slideTimings[i].slide);
        break;
      }
    }
  }

  // ===== 原生播放引擎（与 ztEdit src/animEffects.js 完全一致，契约 v5.5）=====
  // 未知效果 → 跳过（不再 silently 放大）；clipPath/filter 透传；支持回位帧(reset)；fill:none
  function getEffectKeyframes(effect) {
    switch (effect) {
      case 'zoom-in': return { from: { transform: 'scale(0.6)', opacity: 0 }, to: { transform: 'scale(1.3)', opacity: 1 } }
      case 'zoom-out': return { from: { transform: 'scale(1)', opacity: 1 }, to: { transform: 'scale(0.6)', opacity: 0 } }
      case 'fade-in': return { from: { opacity: 0 }, to: { opacity: 1 } }
      case 'fly-left': return { from: { transform: 'translateX(-120px)', opacity: 0 }, to: { transform: 'translateX(0)', opacity: 1 } }
      case 'fly-right': return { from: { transform: 'translateX(120px)', opacity: 0 }, to: { transform: 'translateX(0)', opacity: 1 } }
      case 'fly-top': return { from: { transform: 'translateY(-120px)', opacity: 0 }, to: { transform: 'translateY(0)', opacity: 1 } }
      case 'fly-bottom': return { from: { transform: 'translateY(120px)', opacity: 0 }, to: { transform: 'translateY(0)', opacity: 1 } }
      case 'bounce': return { from: { transform: 'scale(0.8)', opacity: 0 }, to: { transform: 'scale(1.15)', opacity: 1 } }
      case 'rotate': return { from: { transform: 'rotate(-15deg) scale(0.9)', opacity: 0 }, to: { transform: 'rotate(0deg) scale(1)', opacity: 1 } }
      case 'wipe': return { from: { transform: 'translateX(-24px)', clipPath: 'inset(0 100% 0 0)', opacity: 1 }, to: { transform: 'translateX(0)', clipPath: 'inset(0 0% 0 0)', opacity: 1 } }
      case 'flip': return { from: { transform: 'perspective(900px) rotateY(88deg) scale(0.94)', opacity: 0 }, to: { transform: 'perspective(900px) rotateY(0deg) scale(1)', opacity: 1 } }
      case 'blur-in': return { from: { transform: 'scale(1.08)', filter: 'blur(14px)', opacity: 0 }, to: { transform: 'scale(1)', filter: 'blur(0px)', opacity: 1 } }
      case 'slide-spin': return { from: { transform: 'translateX(-140px) rotate(-14deg) scale(0.85)', opacity: 0 }, to: { transform: 'translateX(0) rotate(0deg) scale(1)', opacity: 1 } }
      default: return null
    }
  }
  function kfFrameEntries(kf, dly, dur, ret, baseTransform) {
    var totalDur = dur + ret
    var startOff = dly > 0 ? dly / totalDur : 0
    var endOff = (dly + dur) / totalDur
    var usesExtra = !!(kf.from.clipPath || kf.from.filter || kf.to.clipPath || kf.to.filter)
    function frame(offset, src, reset) {
      var f = { offset: offset, transform: baseTransform + (reset ? 'scale(1)' : (src.transform || 'none')), opacity: reset ? 1 : (src.opacity != null ? src.opacity : 1) }
      if (usesExtra) { f.clipPath = reset ? 'none' : (src.clipPath || 'none'); f.filter = reset ? 'none' : (src.filter || 'none') }
      return f
    }
    var keyframes = []
    if (dly > 0) keyframes.push(frame(0, null, true))
    keyframes.push(frame(startOff, kf.from, false))
    keyframes.push(frame(endOff, kf.to, false))
    if (ret > 0) keyframes.push(frame(1, null, true))
    return keyframes
  }
  function applyStateEffect(el, effect) {
    if (!el || !effect) return false
    if (effect === 'highlight-sweep') {
      if (!el.classList.contains('zt-hl-sweep')) {
        el.classList.add('zt-hl-sweep')
        requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.add('zt-hl-active') }) })
      } else {
        el.classList.add('zt-hl-active')
      }
      return true
    }
    if (effect.indexOf('focus-') === 0) {
      var grp = el.closest ? el.closest('.focus-group') : null
      if (grp) grp.classList.add('dim-others')
      el.classList.add('zt-focus-active')
      return true
    }
    return false
  }
  function playAnimation(el, effect, duration, delay, returnSec, easing) {
    if (!el) return
    if (!effect) return
    if (applyStateEffect(el, effect)) return
    var kf = getEffectKeyframes(effect)
    if (!kf) { if (typeof console !== 'undefined' && console.warn) console.warn('[ztEdit] 未知动画效果：', effect); return }
    var dur = parseFloat(duration) || 1
    var dly = parseFloat(delay) || 0
    var ret = parseFloat(returnSec) || 0
    var ease = easing || 'ease'
    var totalDur = dur + ret
    var baseTransform = el.style.transform || (getComputedStyle(el).transform && getComputedStyle(el).transform !== 'none' ? getComputedStyle(el).transform : '')
    if (baseTransform) baseTransform += ' '
    if (el.getAnimations) el.getAnimations().forEach(function (a) { a.cancel() })
    el.animate(kfFrameEntries(kf, dly, dur, ret, baseTransform), { duration: totalDur * 1000, easing: ease, fill: 'none' })
  }


  function loop(){
    if(!isPlaying) return;
    const t = audio.currentTime;
    updateSlide(t);
    updateSubtitle(t);
    const cur = slides[currentSlide];
    if(cur){
      const slideStart = slideTimings[currentSlide] ? slideTimings[currentSlide].start : 0;
      cur.querySelectorAll('[data-zt-role="subtitle"]').forEach(function(subEl){
        const boundSel = subEl.getAttribute('data-zt-bound-to');
        if(!boundSel) return;
        const boundEl = document.querySelector(boundSel);
        if(!boundEl) return;
        const effect = boundEl.getAttribute('data-zt-anim-effect') || '';
        const absStart = slideStart + parseFloat(subEl.getAttribute('data-zt-subtitle-start') || 0);
        if(effect.indexOf('focus-') === 0){
          if(!boundEl.dataset.focusDone && t >= absStart){
            boundEl.dataset.focusDone = '1';
            const grp = boundEl.closest('.focus-group');
            if(grp) grp.classList.add('dim-others');
            boundEl.classList.add('zt-focus-active');
          }
        } else {
          if(!boundEl.dataset.animDone && t >= absStart && t < absStart + 0.5){
            boundEl.dataset.animDone = '1';
            playAnimation(boundEl, effect, boundEl.getAttribute('data-zt-anim-duration'), boundEl.getAttribute('data-zt-anim-delay'), boundEl.getAttribute('data-zt-anim-return'), boundEl.getAttribute('data-zt-anim-easing'));
          }
        }
      });
    }
    if(audio.duration) progressBar.style.width = (t / audio.duration * 100) + '%';
    requestAnimationFrame(loop);
  }

  function startPlayback(){
    if(isPlaying) return;
    audio.play().then(function(){ isPlaying = true; loop(); }).catch(function(){});
  }

  // 关键：document 监听键盘，确保 file:// 下未 focus 也能响应
  document.addEventListener('keydown', function(e){
    if(e.key === 'ArrowRight'){
      e.preventDefault();
      if(currentSlide < slides.length - 1){ showSlide(currentSlide + 1, true); manualOverrideUntil = Date.now() + 3000; }
    } else if(e.key === 'ArrowLeft'){
      e.preventDefault();
      if(currentSlide > 0){ showSlide(currentSlide - 1, true); manualOverrideUntil = Date.now() + 3000; }
    } else if(e.key === ' ' || e.code === 'Space'){
      e.preventDefault();
      if(!isPlaying) startPlayback();
    }
  });

  document.addEventListener('click', function(e){
    if(!isPlaying){ startPlayback(); return; }
    const x = e.clientX / window.innerWidth;
    if(x > 0.5){ if(currentSlide < slides.length - 1){ showSlide(currentSlide + 1, true); manualOverrideUntil = Date.now() + 3000; }}
    else { if(currentSlide > 0){ showSlide(currentSlide - 1, true); manualOverrideUntil = Date.now() + 3000; }}
  });

  // 页面加载后自动开始播放（录屏场景需要）
  window.addEventListener('load', function(){ setTimeout(startPlayback, 300); });

  // 初始化显示第一页
  showSlide(0);
})();
