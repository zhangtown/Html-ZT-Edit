# HTML-ZtEdit

> 专为「手写原生 HTML 视觉页」打造的可视化编辑器。直接编辑真实 DOM（不是组件物料模型），因此你页面里的 CSS 动画、绝对定位布局、字幕、拼贴图都会原样保留。

本项目起源于一个真实需求：用户有一份约 28 屏的自动播放 HTML 视觉页（纯原生 HTML + CSS `@keyframes` 动画 + 1 段自动播放脚本），希望对其中控件做拖拽、对齐、改样式等操作。通用低代码引擎（如 Rxdrag）只认自己的 JSON schema、解析不了任意 HTML，于是本项目参考其「画布 + 选中 + 通信」思路，针对原生 HTML 重写了一套轻量编辑器。

---

## 功能特性

| 类别 | 能力 |
| --- | --- |
| 加载 | 选择整个文件夹，自动读取 HTML 及其**同目录的图片 / 视频等依赖**（本地读取，不上传任何服务器） |
| 翻页 | 顶部「上一页 / 下一页」控制 `.slide` 页面切换，单独接管，不再被原自动播放脚本干扰 |
| 拖动 | 画布内点选任意元素（图片 / 卡片 / 文字 / 字幕）即可拖动；用 `transform: translate` 平移，**不重排兄弟元素** |
| 撤销/重做 | `Ctrl+Z` 撤销、`Ctrl+Shift+Z`（或 `Ctrl+Y`）重做，覆盖位置 / 尺寸 / 样式 / 文字 / 增删 |
| 多选 | 按住 `Ctrl` 点击可多选，多选后可**整组一起拖动** |
| 对齐/分布/等尺寸 | 左对齐(L)、水平居中(C)、右对齐(R)、顶端对齐(T)、垂直居中(M)、底端对齐(B)、横向分布(H)、纵向分布(V)、等高(E)、等宽(W)、等尺寸(Q) |
| 网格 | 网格模式开关，拖动时自动吸附对齐 |
| 草稿 | 编辑进度自动存到本机 IndexedDB，刷新浏览器后自动恢复；可「清除草稿」 |
| 属性面板 | 改宽度 / 高度 / 文字色 / 背景色 / 字体 / 字号 / 字重；双击文字可进入编辑（改 / 删） |
| 复制粘贴 | `Ctrl+C` 复制、`Ctrl+V` 粘贴，**可跨页**复制粘贴元素 |
| 导出 | 一键导出 `edited.html`：资源恢复相对路径、自动播放脚本还原、开场页 `active` 正确重置 |

---

## 技术栈

- React 18 + Vite 5
- 纯前端，无后端依赖
- 编辑器以 `iframe` 沙箱承载被编辑页面，父窗口（React）与 iframe 通过 `postMessage` 通信
- 草稿持久化：`IndexedDB`

## 目录结构

```
HTML-ZtEdit/
├── 打包.bat            # 一键打包 Windows 桌面 exe（双击：装依赖 + Electron 打包，已内置国内镜像）
├── index.html          # 应用入口
├── vite.config.js      # Vite 配置（base 设为相对路径，便于分发）
├── package.json
└── src/
    ├── main.jsx          # 挂载 React
    ├── App.jsx           # 主界面：工具栏 / iframe 画布 / 属性面板 / 通信
    ├── editorRuntime.js  # 注入 iframe 的纯脚本：选中 / 拖动 / 网格 / 翻页 / 对齐 / 导出
    ├── loadFolder.js     # 文件夹选择、相对路径解析
    ├── htmlProcess.js    # 剥离脚本 / 资源重写 blob / 导出还原
    ├── draftStore.js     # IndexedDB 草稿自动存 / 恢复
    └── index.css
```

---

## 快速开始（本地开发）

> 前置：Node.js LTS 18+，并建议使用 npm。

```bash
# 1. 安装依赖
npm install

# 2. 启动开发服务器（默认 http://localhost:5173）
npm run dev
```

用浏览器打开 `http://localhost:5173` 即可。

## 一键打包（Windows 桌面程序）

直接**双击项目根目录的 `打包.bat`** 即可，它会自动完成三步：

1. 设置国内镜像（`npm` 源 + `Electron` 二进制镜像 + 辅助二进制镜像），避免公司代理下从 GitHub 下载卡死；
2. `npm install` 安装依赖；
3. `npm run electron:build` 打包成 `dist-electron/HTML-ZT-Edit Setup *.exe`。

> 这些镜像与「跳过证书校验」环境变量只在本次 bat 运行内生效，不会修改你全局的 npm 配置。

`dist/` 为 web 构建产物（可部署静态站点）；`dist-electron/` 为桌面安装包。

Linux / macOS 或喜欢命令行的用户，手动执行：

```bash
export npm_config_registry=https://registry.npmmirror.com
export ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binary/
export NODE_TLS_REJECT_UNAUTHORIZED=0
npm install
npm run electron:build
```

---

## 打包为 Windows 桌面程序（Electron）

如果你希望**不装 Node、不启服务器、双击就能用**，可以把本项目打包成一个独立的 Windows 可执行程序（`.exe`）。采用 Electron：内置浏览器内核，离线可用，可拷贝给任何人。

### 1. 安装桌面端依赖（首次）
```bash
npm install        # 会自动安装 electron / electron-builder
```

### 2. 打包成 exe
```bash
npm run electron:build
```
脚本会先 `vite build` 产出 `dist/`，再用 `electron-builder` 打包。完成后在 `dist-electron/` 目录下得到 **`HTML-ZT-Edit Setup x.x.x.exe`**（NSIS 安装包），双击安装后，安装目录里有 `HTML-ZT-Edit.exe` 可直接运行。

### 3. 本地调试桌面端（开发时）
```bash
npm run electron:dev     # 先构建 dist，再启动 Electron 窗口加载本地服务
```

### 原理
`electron/main.cjs` 用 Node 内置 `http` 把 `dist/` 作为本地静态服务托管（随机空闲端口），再由 `BrowserWindow` 加载 `http://127.0.0.1:<port>/`。这样完全规避了 `file://` 下 ES 模块 / blob URL / iframe 的兼容问题，且沿用你浏览器里的全部能力（`webkitdirectory` 选文件夹、`IndexedDB` 草稿、`blob` 资源等）。

> 提示：打包体积约 100MB+（含 Chromium 内核），首次 `npm install` 需下载 Electron 运行时，请耐心等待。

---

## 使用说明

1. **载入页面**
   点击顶部「选择文件夹」，选中包含你的 HTML 的那个**整个目录**（这样同目录的图片、视频等依赖才能被正确加载）。在弹出的文件列表里选择要编辑的 `.html`。

2. **编辑元素**
   - 在画布中**单击**任意元素即可选中（出现红色轮廓），拖动即可平移。
   - **双击**文字元素可进入文字编辑（Enter 提交 / Esc 取消）。
   - 按住 **Ctrl** 单击可**多选**，多选后拖动其中任一元素，整组一起移动。

3. **翻页**
   顶部「← 上一页 / 下一页 →」配合「当前 / 总页」显示。编辑器会接管页面切换，避免原动画干扰编辑。

4. **对齐与分布**（需先多选 ≥2 个元素）
   在右侧「对齐」标签页点击按钮，或直接按快捷键：
   - 左对齐 `L`、水平居中 `C`、右对齐 `R`
   - 顶端对齐 `T`、垂直居中 `M`、底端对齐 `B`
   - 横向分布 `H`、纵向分布 `V`
   - 等高 `E`、等宽 `W`、等尺寸 `Q`

5. **网格对齐**
   顶部「网格：开 / 关」叠加网格背景，拖动元素时自动吸附。

6. **改样式**
   右侧「属性」标签页可改选中元素的宽度、高度、文字色、背景色、字体、字号、字重。

7. **复制 / 粘贴**
   选中元素后 `Ctrl+C` 复制，`Ctrl+V` 粘贴（可切到其它页再粘贴，实现跨页复制）。

8. **撤销 / 重做**
   `Ctrl+Z` 撤销，`Ctrl+Shift+Z`（或 `Ctrl+Y`）重做。

9. **导出**
   点击「导出 HTML」，生成 `edited.html`。资源引用恢复为相对路径，原自动播放脚本与开场页状态都已正确处理，放到与原资源相同的目录即可正常播放。

---

## 部署说明

`dist/`（或开发态的 `index.html`）是纯静态前端，可部署到任意静态服务器。因为是 SPA，路由需配置 history fallback，否则刷新会 404：

**Nginx**
```nginx
location / {
    root   html;
    index  index.html index.htm;
    try_files $uri $uri/ /index.html;   # SPA 必须加
}
```

**Vercel / GitHub Pages / CDN**：直接上传 `dist/` 内容即可，无需额外后端。

---

## 重要说明 / 注意事项

- **全程本地**：「选择文件夹」仅在你浏览器内存中读取文件，转换为 blob 链接注入画布，**没有任何数据上传到任何服务器**。
- **刷新会清空内存**：刷新或关闭标签页后，选中的文件、blob 链接、当前编辑进度都会从内存释放（磁盘原文件不受影响）。但**草稿（IndexedDB）会自动恢复**编辑进度；想重新载入原文件，点「选择文件夹」即可。
- **导出文件与资源**：`edited.html` 里图片 / 视频是相对路径，需把 `edited.html` 与原资源放在同一目录才能正常显示。
- **编辑态冻结动画**：编辑时页面 CSS 动画被临时冻结以便稳定拖拽，导出时已自动移除该规则，动画照常恢复。
- **提交身份**：若从源码仓库克隆后参与提交，请按需设置自己的 `git config user.name / user.email`。

---

## 已知问题 / 后续计划

- 属性面板可继续扩展：旋转、透明度、层级 `z-index`。
- 导出时可增加「资源是否齐全」校验提示。
- 可接入后端实现设计稿云端保存与多人协作（当前为纯前端）。

欢迎提 Issue / PR。
