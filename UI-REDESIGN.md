# ztEdit 界面重构设计文档（v1）

> 面向实施者（可以是另一个 agent）。本文档是自包含的：不读本文档以外的材料也能动手，
> 但动手前请按「§1 必读现状」核对代码行号是否漂移（本文档基于 commit `9cce9c4`）。

---

## 0. 任务一句话

在 `dev/page-redesign` 分支上，对 ztEdit 编辑器界面做一轮**布局与视觉精修**，
让它看起来像一个打磨过的桌面创意工具（Keynote / CapCut / Linear 那一档），
而不是「能用的内部工具」。**只动 UI，不动任何数据格式与功能逻辑。**

---

## 1. 必读现状

### 1.1 技术栈与文件分工

| 文件 | 作用 | 本次能否动 |
|---|---|---|
| `src/App.jsx`（约 2360 行） | 全部界面 JSX + 状态 | ✅ 主战场，只改 JSX 结构 / className / 内联样式 |
| `src/index.css`（约 1238 行） | 设计令牌 + 全部界面样式 | ✅ 主战场 |
| `src/editorRuntime.js` | 注入 iframe 的编辑内核 | ❌ 禁止改 |
| `src/htmlProcess.js` | 导入/导出/播放脚本生成 | ❌ 禁止改 |
| `src/animEffects.js` | 动画效果清单 | ❌ 禁止改（动了会触发跨仓库契约同步，见 `AGENTS.md`） |
| `electron/` | OBS 录屏等 | ❌ 禁止改 |

**契约红线**（来自 `AGENTS.md`）：凡是改动字幕/绑定/动画/时间轴的数据格式或 `data-zt-*` 属性，
必须走跨仓库契约同步流程。本任务**不应触碰**——如果实施中发现不得不碰，停下来问，不要硬改。

### 1.2 当前布局结构（commit `9cce9c4` 实测）

```
┌─ .zt-bar（46px 深色 chrome，可横向滚动）──────────────────────────┐
│ [ZT 品牌] [选择文件|导出|草稿] [撤销|重做|删除|还原] [网格|分辨率|缩放100%] 「本地运行·不上传」 │
├─ .zt-subbar（40px 深色）────────────────────────────────────────┤
│ [‹ 页面 1 2 3 ›]  …状态文本散落中间…   [本页预览|音频延迟] [1080P|2K|4K] [● OBS 录制] │
├─ .zt-main ───────────────────────────────────────────────┤
│ ┌─ .zt-stage（点阵底纹画布区）──────────┐ ┌─ .zt-side 288px ─┐ │
│ │  iframe 画布（白卡+投影）            │ │ Tab: 属性|素材|图层|信息 │ │
│ └─────────────────────────────┘ │  面板内容滚动区     │ │
│                                  └────────────────┘ │
├─ .zt-timeline（深色）─────────────────────────────────────┤
│ [上移一页|下移一页|绑定|解除绑定] [动画 inline 条]            │
│ 0s [════字幕块轨道════] 45s                                │
└──────────────────────────────────────────────────┘
```

右键菜单 `.zt-menu`：复制/剪切/粘贴/删除 ｜ 置顶/上移/下移/置底 ｜ 组合/取消组合/锁定 ｜ 对齐▸（二级菜单）。

### 1.3 已有设计令牌（`index.css` 顶部，**不要重造**）

- 中性色：zinc 冷灰 `--n-0`…`--n-900`；亮底表面 `--surface` / `--surface-sunken` / `--bg-canvas`
- 深色外壳：`--chrome` #1c1c1f 系列（顶栏、底栏、时间轴）
- 主色：朱红 `--accent` #c41e24（亮底）/ `--accent-dark` #d93a40（深底），仅用于主操作、选中态、激活态、录制中
- 语义色：**只有两个**——teal `--state-subtitle`（字幕/绑定）、amber `--state-global`（全局字幕/进行中的动作）
- 圆角标度：4 / 6 / 8 / 12 / 999px，一套到底
- 阴影：随底色着色（`--sh-1/2/3/pop`），禁纯黑投影
- 动效：仅 120–180ms 过渡（`--ease`），无循环动画
- 图标：`@phosphor-icons/react`（已装），全局 `IconContext size:14 weight:regular`

---

## 2. 设计判断（Design Read）

**桌面创意工具，深色 chrome + 亮色工作区的混合主题**——参照 CapCut / Keynote / Linear 的工具感：
外壳深沉收敛，画布明亮聚焦。密度偏高（专业工具），动效克制（MOTION 3/10：只有过渡与按下反馈），
布局规整但拒绝呆板（VARIANCE 5/10）。

**一个主题锁死**：chrome 深色只出现在顶栏/底栏/时间轴外壳；工作区（画布底、侧栏、面板、菜单、空状态）全亮。
不允许中途反色。

---

## 3. 问题诊断（按优先级）

### P0 功能/一致性缺陷

1. **缩放是死文本**（`App.jsx` 约 964 行）：`缩放 100%` 只是只读 label，用户改不了。
   画布缩放范围 0.2–1.5（50% 以下步进 5%，以上 10%）已在逻辑层存在，唯独没有 UI 入口。
2. **状态色违反自己的令牌注释**：`index.css` 里 `.zt-bar-note-ok` 用绿色 `#86efac`、
   `.zt-bar-note-err` 用红色 `#fca5a5`，但令牌注释明确写了「其余颜色（蓝、绿、紫）全部移除」。
   实现和规则打架，要按规则改实现。
3. **图标不一致**：右键菜单前 4 项有图标、层级 4 项（置顶/上移/下移/置底）和组合项没有；
   时间轴「确认」用 `zt-btn--strong` 亮白、「OBS 录制」也用 `zt-btn--strong`——两种语义撞一个样式。

### P1 视觉粗糙点

4. **顶栏渐变多余**：`.zt-bar` 有 `linear-gradient(180deg,#232327,var(--chrome))`，
   拟物时代的残留，压平更现代。
5. **状态文本散落**：subbar 中间 6 种状态（播放中/录制中/草稿失败/导出消息/OBS 消息/成片路径）
   是裸文本，样式不统一、没有容器，多条并排时显得乱。
6. **分辨率下拉截断**：「当前屏幕 (CSS 1536×864 / 物理 ...)」在 `maxWidth:132` 里必然截断。
7. **品牌区占宽**：`ZtEdit + HTML 可视化编辑器` 双行，窗口窄时挤压工具组。
8. **空状态卡片已不错**，但图标容器是红底浅色块（`--accent-soft`），可再克制一点（见 §5.6）。

### P2 可以不动

侧栏 Tab、属性面板分组、素材网格、图层行、时间轴轨道——结构都已合理，只做样式微调，不换布局。

---

## 4. 改动清单（实施项）

> 每项都给出：位置 → 现状 → 改成什么 → 为什么。编号即实施顺序。

### 4.1 缩放步进器（P0，顶栏第一行）

**位置**：`App.jsx` 约 964–966 行，`<span className="zt-bar-field">缩放 {Math.round(zoom*100)}%</span>`。

**改成**：一个分段控件 `[−] [100%] [＋]`：

- 复用现有 `.zt-seg` 外壳样式，或新建 `.zt-zoom`（深色 chrome 语境）
- `−` / `＋`：按当前值步进——`zoom >= 0.5` 步进 0.1，`zoom < 0.5` 步进 0.05；clamp 到 `[0.2, 1.5]`，
  用 `+v.toFixed(2)` 去浮点尾
- 中间百分比做成可点击按钮：单击复位 `setZoom(1)`，title 提示「点击复位 100%」
- 到边界（20% / 150%）时对应按钮 disabled
- 三个元素高度对齐 `.zt-seg-item`（约 24px），数字区 `min-width:44px; text-align:center; tabular-nums`

**为什么**：缩放是编辑高频操作（模拟 4K 分辨率时必用），只读文本是半成品。

### 4.2 状态色按令牌收敛（P0，index.css）

**位置**：`.zt-bar-note-ok`（约 378 行）、`.zt-bar-note-err`（约 381 行）。

**改成**：

- `.zt-bar-note-ok`：删绿色。成功状态用 `color: var(--chrome-text)` + 前置 ✓ 图标（JSX 里已有 `Check` 可复用）——成功不需要颜色编码，图标足够
- `.zt-bar-note-err`：删 `#fca5a5` 粉红。错误用 `color: var(--accent-dark)`（#d93a40，深底对比度 3.8:1，11.5px 粗体可读）+ 前置 `Warning` 图标
- 「播放中」note 现在用 `var(--state-global-dark)` amber —— **保留**，符合「amber = 进行中的动作」
- 「录制中」note 现在带 `zt-bar-note-err`——改为：品牌红 `Record` 图标（recording 语义本来就用红）+ `var(--chrome-text)` 文字，不与「错误」混

**同时**把 `index.css` 顶部令牌注释里补一句：「状态文字：成功=中性白+✓，错误=accent-dark+⚠，进行中=amber，录制中=品牌红图标」，
让注释和实现从此一致。

### 4.3 状态消息徽标化（P1，App.jsx + index.css）

**位置**：subbar 的 `.zt-subbar-notes` 区块（约 1013–1047 行）。

**改成**：所有状态统一渲染为 pill 徽标——新建 `.zt-note`：

```css
.zt-note {
  display: inline-flex; align-items: center; gap: 5px;
  height: 22px; padding: 0 9px;
  border: 1px solid var(--chrome-border);
  border-radius: var(--r-pill);
  background: rgba(255,255,255,.04);
  font-size: 11.5px; color: var(--chrome-text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 280px; flex-shrink: 0;
}
.zt-note[data-tone="err"]  { color: var(--accent-dark); border-color: rgba(217,58,64,.35); }
.zt-note[data-tone="busy"] { color: var(--state-global-dark); border-color: rgba(251,191,36,.3); }
.zt-note[data-tone="rec"]  { color: var(--accent-dark); border-color: rgba(217,58,64,.35); }
```

6 种状态逐个套 tone：播放中=busy、录制中=rec、草稿失败=err、导出消息（已导出头=默认/err）、
OBS 消息=默认、成片路径=默认（带 `Check` 图标）。长路径只显示文件名（现状已截文件名，保留）。

**为什么**：容器统一后，多条状态并排是一排整齐的胶囊，而不是一摊字。

### 4.4 顶栏压平（P1，index.css）

- `.zt-bar` 去掉 `linear-gradient`，直接 `background: var(--chrome)`
- `.zt-brand` 的副标题 `zt-brand-sub`（「HTML 可视化编辑器」）：窗口 < 1180px 时 `display:none`
  （用 `@media (max-width:1180px)`；品牌行本身就 `user-select:none`）
- `.zt-group` 容器背景从 `rgba(255,255,255,.045)` 降到 `.035`，边框保留——三组胶囊再安静一点

### 4.5 分辨率下拉长文本（P1，App.jsx 约 957–961 行）

「当前屏幕」选项的 label 太长。**改成**：

- option 显示文本：`当前屏幕 (1536×864)`（只留 CSS 分辨率，物理分辨率删掉——用户选档时关心的是 CSS 像素）
- 完整信息（CSS + 物理）挪到该 option 所在 select 的 `title` 上动态拼接
- `maxWidth: 132` 可保留，或放宽到 150

### 4.6 右键菜单图标补齐（P1，App.jsx ContextMenu，约 2296–2312 行）

层级与组合 6 项补 Phosphor 图标，跟前 4 项对齐（都已 import 或可补 import）：

| 菜单项 | 图标 |
|---|---|
| 置顶 | `ArrowLineUp` |
| 上移 | `ArrowUp`（已 import） |
| 下移 | `ArrowDown`（已 import） |
| 置底 | `ArrowLineDown` |
| 组合 | `Group` |
| 取消组合 | `Ungroup` |
| 锁定/解锁 | 已有 `LockSimple` / `LockSimpleOpen` |

新 import：`ArrowLineUp, ArrowLineDown, Group, Ungroup`（@phosphor-icons/react 全部有）。

### 4.7 「确认绑定」按钮降档（P1，App.jsx 约 2136–2143 行）

时间轴绑定模式的「确认」现在用 `zt-btn--strong`（亮白底），与「OBS 录制」撞衫。
**改成** `zt-btn--primary`（品牌红）——主操作语义，且和「绑定」teal 语义不冲突（按钮是动作不是状态）。

### 4.8 空状态微调（P2，index.css `.zt-empty-*`）

- `.zt-empty-icon` 的红底浅块改成中性：`background: var(--surface-sunken); border:1px solid var(--border); color: var(--text-3)`——红留给真正的操作
- 主按钮 `zt-btn--accent`（红）保留，它是这个页面唯一的主操作，焦点正确

---

## 5. 全局红线（实施时逐条核对）

1. **不改消息协议**：`send({type:...})` 的 type、payload 一律不动；不新增、不删除消息类型
2. **不改数据格式**：`data-zt-*` 属性、字幕/绑定/动画的任何字段名不动
3. **图标只用 `@phosphor-icons/react`**，不手绘 SVG，不混第二个图标库
4. **颜色只用 §1.3 的令牌**；新增颜色先进 `:root` 令牌区并写注释，不允许 JSX/内联里出现裸 hex
   （`STYLE_TAG` 里 iframe 内部的选中框颜色除外，那是注入页面的，不在本次范围）
5. **圆角只用令牌标度** 4/6/8/12/999
6. **不加循环动画**；只允许 transition（120–180ms，用 `--ease`）
7. **禁纯黑 `#000` / 纯白 `#fff` 投影**；新阴影用 `--sh-*`
8. **中文文案不改语义**（按钮叫「导出」就还叫「导出」），只准微调标点与提示文本
9. **深色 chrome 与亮色工作区的边界不动**：顶栏/底栏深，其余亮，不做 section 级反色
10. **断点与滚动**：`.zt-bar` 保持窄窗口横向滚动不换行；侧栏固定 288px 不动（`--side-w`）

---

## 6. 验证清单（做完逐项打勾）

```bash
npm run build           # 必须通过
npm run check:contract  # 必须通过（本任务不应改变契约，若失败说明碰了不该碰的）
```

视觉走查（`npm run dev` 后开 http://localhost:5173，用内置浏览器截图核对）：

- [ ] 空状态页：卡片居中、图标容器已改中性、红色只在主按钮
- [ ] 打开 `测试工程/speech-visual-test.html`：两行顶栏无挤压、缩放步进器可用（−/+ 改变画布，点 % 复位）
- [ ] 切到「素材」Tab：面板正常渲染（注意：本任务已顺手修掉 `UploadSimple2` 未导入的崩溃 bug）
- [ ] 触发出状态消息（导出一次）：subbar 状态是一排统一胶囊
- [ ] 右键画布：菜单 10 项图标全部就位、无缺失
- [ ] 时间轴选中字幕后点「绑定」：确认按钮是品牌红不是亮白
- [ ] 窗口缩到 ~1000px：顶栏横向滚动不换行，品牌副标题已隐藏
- [ ] 全页搜不到 `#86efac` / `#fca5a5` / `UploadSimple2`

---

## 7. 本仓库当前遗留物（实施前先清理）

上一个 agent（写本文档的）留下的垃圾文件，**直接删**：

- `scripts/shot-web.cjs`（没跑起来的 Electron 截图脚本）
- `dev-server.log`、`shot-stdout.txt`（日志）
- `dist/`（构建产物，确认 `.gitignore` 已忽略；若在 git 跟踪里则 `git rm -r --cached dist`）

另外它已顺手修复一个 P0 bug：`App.jsx` 素材面板用了未导入的 `UploadSimple2`（会崩溃），
已改为 `UploadSimple`、`npm run build` 通过，并随本文档一起 commit 进分支。

---

## 8. 提交建议

本文档与 `UploadSimple2` 崩溃修复已先行 commit。实施完成后单独提交：

- `style(界面): 布局精修——缩放步进器/状态徽标化/顶栏压平/菜单图标补齐/令牌注释同步`（§4 全部）

push 到 `origin/dev/page-redesign`。契约版本号**不需要**动（本任务无格式变更）。
