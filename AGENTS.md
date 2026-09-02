# Html-ZtEdit Agent 指引

ztEdit：手写 HTML 页面的可视化编辑器（React + Vite + Electron）。核心：`src/App.jsx`（界面）、`src/editorRuntime.js`（注入 iframe 的编辑内核）、`src/htmlProcess.js`（导入/导出/播放脚本生成）、`electron/obsRecorder.cjs`（OBS 录屏）。

## ⚠️ 跨仓库契约同步（最重要规则）

本仓库 WORKFLOW.md「二、数据模型」是 **ztEdit 原生格式契约的正本**（当前 v5.4）。该契约的另一个实现方在**另一个仓库**：

- 仓库：`https://github.com/zhangtown/my-skills`（本机主库 `~/.agents/skills/`）
- 文件：`speech-visual-html/SKILL.md`「ztEdit 原生格式规范」章节

**规则**：凡是改动字幕/绑定/动画/时间轴的数据格式或动画效果清单（`editorRuntime.js` 的效果实现、导出格式 `data-zt-*` 属性），必须：

1. 正本版本号 +0.1（WORKFLOW.md「当前契约版本 vX.Y」）
2. 同版本更新 my-skills 里 `speech-visual-html/SKILL.md` 的「ztEdit 原生格式规范（vX.Y）」章节
3. 两仓各自 commit + push，并在本仓库跑 `npm run check:contract` 确认版本一致（不一致会退出码 1）

只改编辑器 UI/交互/录屏等不影响数据格式的改动，无需动契约。

## 常用命令

```bash
npm run dev              # Web 调试 http://localhost:5173
npm run dev:electron     # Electron 桌面调试
npm run build            # 产物 dist/
npm run check:contract   # 契约版本校验（见上）
打包.bat                  # Windows 一键打包（自动配国内镜像）
```

## 技能管理（skill-manager）

本机所有 skill 由 skill-manager 统一管理：技能本体只存中央仓库 `~/.skills-manager/skills/`，`~/.zcode/skills/`、`~/.claude/skills/` 等 agent 目录下的条目都是指向中央仓库的 JUNCTION 链接。装/删/更新技能一律走 skill-manager，不要往 agent 目录手工拷贝技能文件（拷贝件脱离中央管理，各端不同步）。注意：新链接的技能要新开会话才会被 Agent 加载。

## 环境备忘

- 企业网有 TLS 拦截：npm 装 Electron 二进制需 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` + `NODE_OPTIONS=--use-system-ca`；GitHub 下载慢时走 `https://gh-proxy.com/` 前缀
- 大资产（MP3/素材/成品页/样例工程）不入 git，换机手动拷贝（见 WORKFLOW.md「三」）
- 提交习惯：完成一个点就 commit + push（本地提交 GitHub 看不到）
