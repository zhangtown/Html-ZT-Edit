// 生成 测试工程/speech-visual-test.html（ztEdit 原生格式回归测试样例）
// node scripts/gen-speech-visual-test.mjs
//
// 用途：作为 speech-visual-html 技能产物在 ztEdit 里的回归测试样例，覆盖：
//   1. 每页 ≥2 条 DOM 字幕（测字幕↔元素绑定）
//   2. 全部 15 种动画效果（focus-zoom/highlight-sweep 强调 + 13 种入场）都有触发机会
//   3. 严格符合 speech-visual-html SKILL.md「ztEdit 原生格式规范」：
//      .slide-subtitles 容器 + data-zt-role=subtitle + data-zt-subtitle-start/end（相对秒）
//      + data-zt-bound-to 绑定 + data-zt-id 标识 + data-zt-anim-effect 动画 + focus-group 分组
//      + 内嵌 IIFE 播放脚本（slideTimings 绝对时间，DOM 读字幕构建 subtitles[]）
//      + focus 联动 CSS 全套（zt-focus-active / dim-others / zt-hl-sweep 划线）
//
// 时间轴/绑定/元素全由下方 pages 数据驱动生成，避免手算时间戳出错。
// 改动测试内容只改 pages 数据，重新运行即可再生成。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outPath = path.join(root, '测试工程/speech-visual-test.html')

// ---- 页面数据：start/end 为绝对秒（slideTimings），subs[].t 为该页内相对秒 ----
const pages = [
  {
    id: 's0', cls: 'active', start: 0.0, end: 8.6,
    content: `
    <div class="cover-title focus-item" data-zt-id="el-0-0" data-zt-anim-effect="focus-zoom">Html-ZT-Edit</div>
    <div class="cover-sub focus-item" data-zt-id="el-0-1" data-zt-anim-effect="highlight-sweep">可视化编辑器 · 产品演示</div>
    <div class="collage">
      <img class="c1" src="red.png" alt="红">
      <img class="c2" src="blue.png" alt="蓝">
      <img class="c3" src="green.png" alt="绿">
      <img class="c4" src="yellow.png" alt="黄">
      <img class="c5" src="dark.png" alt="深">
    </div>
    <div class="cover-seal"><span>小踏<br>出品</span></div>`,
    subs: [
      { t: 0.0, d: 3.4, text: '欢迎收看本次产品演示，我是小踏', bind: "el-0-0" },
      { t: 3.7, d: 3.3, text: '这是一款手写 HTML 的可视化编辑器', bind: "el-0-1" },
    ],
  },
  {
    id: 's1', start: 8.6, end: 17.4,
    content: `
    <div class="lr-row">
      <div class="lr-left">
        <div class="page-title">为什么需要它</div>
        <div class="focus-group">
          <div class="tl-card focus-item" data-zt-id="el-1-0" data-zt-anim-effect="focus-zoom"><div class="card-n">01</div><div>手写 HTML 改起来费时费力</div></div>
          <div class="tl-card focus-item" data-zt-id="el-1-1" data-zt-anim-effect="focus-zoom"><div class="card-n">02</div><div>字幕与元素难同步</div></div>
          <div class="tl-card focus-item" data-zt-id="el-1-2" data-zt-anim-effect="focus-zoom"><div class="card-n">03</div><div>动画绑定不直观</div></div>
        </div>
      </div>
      <div class="lr-right"><img class="mat-img" src="red.png" alt="示例"></div>
    </div>`,
    subs: [
      { t: 0.0, d: 2.8, text: '手写 HTML 改起来费时费力', bind: "el-1-0" },
      { t: 3.1, d: 2.8, text: '字幕与元素难以同步', bind: "el-1-1" },
      { t: 6.2, d: 2.4, text: '动画绑定更是不直观', bind: "el-1-2" },
    ],
  },
  {
    id: 's2', start: 17.4, end: 26.0,
    content: `
    <div class="lr-row">
      <div class="lr-left">
        <div class="page-title">入场动画 · 淡入与飞入</div>
        <div class="demo-list">
          <div class="demo-row focus-item" data-zt-id="el-2-0" data-zt-anim-effect="fade-in"><span class="demo-tag">fade-in</span>淡入出现</div>
          <div class="demo-row focus-item" data-zt-id="el-2-1" data-zt-anim-effect="fly-left"><span class="demo-tag">fly-left</span>从左侧飞入</div>
          <div class="demo-row focus-item" data-zt-id="el-2-2" data-zt-anim-effect="zoom-in"><span class="demo-tag">zoom-in</span>放大出现</div>
        </div>
      </div>
      <div class="lr-right"><img class="mat-img" src="blue.png" alt="示例"></div>
    </div>`,
    subs: [
      { t: 0.0, d: 2.8, text: '第一种效果，淡入出现', bind: "el-2-0" },
      { t: 3.1, d: 2.8, text: '第二种效果，从左侧飞入', bind: "el-2-1" },
      { t: 6.2, d: 2.4, text: '第三种效果，放大出现', bind: "el-2-2" },
    ],
  },
  {
    id: 's3', start: 26.0, end: 34.6,
    content: `
    <div class="lr-row">
      <div class="lr-left">
        <div class="page-title">入场动画 · 多方向飞入</div>
        <div class="demo-grid">
          <div class="demo-cell focus-item" data-zt-id="el-3-0" data-zt-anim-effect="fly-right">fly-right</div>
          <div class="demo-cell focus-item" data-zt-id="el-3-1" data-zt-anim-effect="fly-top">fly-top</div>
          <div class="demo-cell focus-item" data-zt-id="el-3-2" data-zt-anim-effect="fly-bottom">fly-bottom</div>
          <div class="demo-cell focus-item" data-zt-id="el-3-3" data-zt-anim-effect="bounce">bounce</div>
        </div>
      </div>
      <div class="lr-right"><img class="mat-img" src="green.png" alt="示例"></div>
    </div>`,
    subs: [
      { t: 0.0, d: 2.2, text: '从右侧飞入', bind: "el-3-0" },
      { t: 2.5, d: 2.2, text: '从上方飞入', bind: "el-3-1" },
      { t: 5.0, d: 1.8, text: '从下方飞入', bind: "el-3-2" },
      { t: 7.1, d: 1.5, text: '还有弹跳出现', bind: "el-3-3" },
    ],
  },
  {
    id: 's4', start: 34.6, end: 43.2,
    content: `
    <div class="lr-row">
      <div class="lr-left">
        <div class="page-title">特殊效果 · 擦除与翻转</div>
        <div class="demo-list">
          <div class="demo-row focus-item" data-zt-id="el-4-0" data-zt-anim-effect="wipe"><span class="demo-tag">wipe</span>擦除滑入</div>
          <div class="demo-row focus-item" data-zt-id="el-4-1" data-zt-anim-effect="flip"><span class="demo-tag">flip</span>3D 翻转</div>
          <div class="demo-row focus-item" data-zt-id="el-4-2" data-zt-anim-effect="blur-in"><span class="demo-tag">blur-in</span>虚化聚焦</div>
          <div class="demo-row focus-item" data-zt-id="el-4-3" data-zt-anim-effect="slide-spin"><span class="demo-tag">slide-spin</span>旋转滑入</div>
        </div>
      </div>
      <div class="lr-right"><img class="mat-img" src="yellow.png" alt="示例"></div>
    </div>`,
    subs: [
      { t: 0.0, d: 2.2, text: '擦除滑入效果', bind: "el-4-0" },
      { t: 2.5, d: 2.2, text: '3D 翻转效果', bind: "el-4-1" },
      { t: 5.0, d: 1.8, text: '虚化到清晰', bind: "el-4-2" },
      { t: 7.1, d: 1.5, text: '旋转滑入效果', bind: "el-4-3" },
    ],
  },
  {
    id: 's5', start: 43.2, end: 51.8,
    content: `
    <div class="lr-row">
      <div class="lr-left">
        <div class="page-title">复合效果 · 旋转与缩放</div>
        <div class="demo-list">
          <div class="demo-row focus-item" data-zt-id="el-5-0" data-zt-anim-effect="rotate"><span class="demo-tag">rotate</span>旋转出现</div>
          <div class="demo-row focus-item" data-zt-id="el-5-1" data-zt-anim-effect="zoom-out"><span class="demo-tag">zoom-out</span>由大缩小</div>
        </div>
      </div>
      <div class="lr-right"><img class="mat-img" src="dark.png" alt="示例"></div>
    </div>`,
    subs: [
      { t: 0.0, d: 4.0, text: '旋转出现效果', bind: "el-5-0" },
      { t: 4.3, d: 4.3, text: '由大缩小的缩放效果', bind: "el-5-1" },
    ],
  },
  {
    id: 's6', start: 51.8, end: 60.4,
    content: `
    <div class="focus-group end-wrap">
      <div class="end-card focus-item" data-zt-id="el-6-0" data-zt-anim-effect="focus-zoom">
        <div class="end-title">感谢观看</div>
        <div class="end-sub focus-item" data-zt-id="el-6-1" data-zt-anim-effect="highlight-sweep">欢迎使用 Html-ZT-Edit，我们下次再见</div>
      </div>
    </div>`,
    subs: [
      { t: 0.0, d: 3.4, text: '感谢观看，欢迎使用 Html-ZT-Edit', bind: "el-6-0" },
      { t: 3.7, d: 3.3, text: '我们下次再见', bind: "el-6-1" },
    ],
  },
]

// ---- 由 pages 生成 slideTimings / 字幕时间（校验一致性）----
// 方案 B：若存在 口播音频.srt，用其真实朗读时间轴驱动页面（声画同步），
// 否则回退到 pages 里手写的时间。SRT 顺序须与 pages.subs 展开顺序一致（20 条）。
const SRT_PATH = path.join(root, '测试工程/口播音频.srt')
const PAGE_TAIL = 1.4 // 每页末字幕结束后的页尾缓冲（秒），给动画收尾

function parseSrt(filePath) {
  const txt = fs.readFileSync(filePath, 'utf8')
  const blocks = txt.split(/\r?\n\r?\n/)
  const out = []
  for (const b of blocks) {
    const lines = b.split(/\r?\n/)
    if (lines.length < 2) continue
    const tm = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/)
    if (!tm) continue
    const toSec = (h, m, s, ms) => (+h) * 3600 + (+m) * 60 + (+s) + (+ms) / 1000
    out.push({ start: toSec(tm[1], tm[2], tm[3], tm[4]), end: toSec(tm[5], tm[6], tm[7], tm[8]) })
  }
  return out
}

function applySrtTimeline(pagesArr, srt) {
  const flatSubs = []
  pagesArr.forEach((p, pi) => {
    p.subs.forEach((s, si) => flatSubs.push({ pageIdx: pi, subIdx: si }))
  })
  if (flatSubs.length !== srt.length) {
    throw new Error(`SRT 条数 ${srt.length} 与页面字幕总数 ${flatSubs.length} 不一致`)
  }
  // 平铺计算绝对时间
  const abs = flatSubs.map((f, i) => {
    const cur = srt[i]
    const next = srt[i + 1]
    const end = next ? Math.max(cur.end, next.start) : cur.end + 0.6
    return { pageIdx: f.pageIdx, subIdx: f.subIdx, absStart: cur.start, absEnd: end }
  })
  // 每页边界：start=首字幕起点；end=下一页首字幕起点（无缝衔接，动画余量已含在字幕显示窗口里），末页=末字幕结束+PAGE_TAIL
  const pageAbs = pagesArr.map(() => ({ start: 0, end: 0 }))
  abs.forEach((a) => {
    const pa = pageAbs[a.pageIdx]
    if (pa.start === 0 || a.absStart < pa.start) pa.start = a.absStart
  })
  for (let pi = 0; pi < pageAbs.length; pi++) {
    const nextPageFirst = abs.find((a) => a.pageIdx === pi + 1)
    if (nextPageFirst) {
      pageAbs[pi].end = nextPageFirst.absStart
    } else {
      pageAbs[pi].end = abs.filter((a) => a.pageIdx === pi).reduce((m, a) => Math.max(m, a.absEnd), 0) + PAGE_TAIL
    }
  }
  // 回填
  pagesArr.forEach((p, pi) => {
    p.start = pageAbs[pi].start
    p.end = pageAbs[pi].end
    p.subs.forEach((s, si) => {
      const a = abs.find((x) => x.pageIdx === pi && x.subIdx === si)
      s.t = +(a.absStart - p.start).toFixed(3)
      s.d = +(a.absEnd - a.absStart).toFixed(3)
    })
  })
}

if (fs.existsSync(SRT_PATH)) {
  const srt = parseSrt(SRT_PATH)
  applySrtTimeline(pages, srt)
  console.log(`采用 SRT 真实时间轴驱动（${srt.length} 条，末条结束 ${srt[srt.length - 1].end.toFixed(1)}s）`)
}

const slideTimings = pages.map((p) => ({ slide: parseInt(p.id.slice(1), 10), start: p.start, end: p.end }))
for (let i = 0; i < slideTimings.length; i++) {
  const cur = slideTimings[i]
  const next = slideTimings[i + 1]
  if (next && Math.abs(next.start - cur.end) > 0.01) {
    throw new Error(`页 ${cur.slide} end(${cur.end}) 与下一页 start(${next.start}) 不一致`)
  }
  for (const s of pages[i].subs) {
    if (s.t < 0 || s.t + s.d > cur.end - cur.start + 0.01) {
      throw new Error(`页 ${cur.slide} 字幕超界：t=${s.t} d=${s.d} 页长=${(cur.end - cur.start).toFixed(1)}`)
    }
  }
}

const FOCUS_CSS = `
  .focus-group .focus-item{transition:all .6s ease;position:relative}
  .focus-group.dim-others .focus-item{opacity:.35;filter:brightness(.7) blur(1px)}
  .focus-group.dim-others .focus-item.zt-focus-active{opacity:1;filter:brightness(1) blur(0);transform:scale(1.12);z-index:3;box-shadow:0 0 50px rgba(196,30,36,.35)}
  .focus-group.dim-others .focus-item-text{opacity:.35;filter:blur(0)}
  .focus-group.dim-others .focus-item-text.zt-focus-active{opacity:1;transform:scale(1.06);color:var(--red);font-weight:700}
  .zt-hl-sweep{position:relative}
  .zt-hl-sweep::after{content:"";position:absolute;left:0;bottom:-0.18em;height:0.12em;width:100%;background:linear-gradient(90deg,#C41E24,#B8860B);border-radius:2px;transform:scaleX(0);transform-origin:left center;transition:transform .6s cubic-bezier(.25,.46,.45,.94);pointer-events:none}
  .zt-hl-sweep.zt-hl-active::after{transform:scaleX(1)}
`

// ---- 生成播放脚本（与 ztEdit 导出脚本一致：slideTimings 绝对时间 + DOM 读字幕构建 subtitles[]）----
const slidesHTML = pages
  .map(
    (p) => `
  <!-- Slide ${parseInt(p.id.slice(1), 10)} -->
  <div class="slide ${p.cls || ''}" id="${p.id}">
    <div class="slide-subtitles" style="display:none">
${p.subs
  .map((s) => `      <div data-zt-role="subtitle" data-zt-subtitle-start="${s.t}" data-zt-subtitle-end="${(s.t + s.d).toFixed(3)}" data-zt-bound-to="[data-zt-id='${s.bind}']">${s.text}</div>`)
  .join('\n')}
    </div>
${p.content}
  </div>`
  )
  .join('\n')

const PLAYER = `(function(){
  var audio = document.getElementById('bgAudio');
  var slides = document.querySelectorAll('.slide');
  var subtitleEl = document.getElementById('subtitle-bar');
  var progressBar = document.getElementById('progress');
  var currentSlide = 0, currentSubtitle = -1, isPlaying = false, manualOverrideUntil = 0;

  const slideTimings=[${JSON.stringify(slideTimings).slice(1, -1)}];

  var subtitles = [];
  slides.forEach(function(sl, si){
    var st = slideTimings[si]; if(!st) return;
    sl.querySelectorAll('[data-zt-role="subtitle"]').forEach(function(el){
      var rStart = parseFloat(el.getAttribute('data-zt-subtitle-start')) || 0;
      var rEnd = parseFloat(el.getAttribute('data-zt-subtitle-end')) || 0;
      subtitles.push({ startSec: st.start + rStart, endSec: st.start + rEnd, text: el.textContent });
    });
  });

  document.querySelectorAll('[data-zt-anim-effect="highlight-sweep"]').forEach(function(el){ el.classList.add('zt-hl-sweep'); });

  function showSlide(idx, seekAudio){
    slides.forEach(function(s, i){ s.classList.toggle('active', i === idx); });
    currentSlide = idx;
    document.querySelectorAll('.focus-item').forEach(function(el){
      delete el.dataset.animDone; delete el.dataset.focusDone;
      el.classList.remove('zt-focus-active');
    });
    document.querySelectorAll('.focus-group').forEach(function(g){ g.classList.remove('dim-others'); });
    if(seekAudio && isPlaying && audio){
      var st = slideTimings[idx];
      if(st) audio.currentTime = st.start;
    }
  }

  function updateSubtitle(time){
    var ns = -1;
    for(var i = 0; i < subtitles.length; i++){
      if(time >= subtitles[i].startSec && time < subtitles[i].endSec){ ns = i; break; }
    }
    if(ns !== currentSubtitle && ns !== -1){
      subtitleEl.textContent = subtitles[ns].text;
      currentSubtitle = ns;
    }
  }

  function updateSlide(time){
    if(Date.now() < manualOverrideUntil) return;
    for(var i = slideTimings.length - 1; i >= 0; i--){
      if(time >= slideTimings[i].start){
        if(currentSlide !== slideTimings[i].slide) showSlide(slideTimings[i].slide);
        break;
      }
    }
  }

  function playAnimation(el, effect, duration, delay, returnSec, easing){
    if(!el) return;
    var kfMap = {
      'zoom-in': {from:{transform:'scale(0.6)',opacity:0}, to:{transform:'scale(1)',opacity:1}},
      'zoom-out': {from:{transform:'scale(1.4)',opacity:0}, to:{transform:'scale(1)',opacity:1}},
      'fade-in': {from:{opacity:0}, to:{opacity:1}},
      'fly-left': {from:{transform:'translateX(-160px)',opacity:0}, to:{transform:'translateX(0)',opacity:1}},
      'fly-right': {from:{transform:'translateX(160px)',opacity:0}, to:{transform:'translateX(0)',opacity:1}},
      'fly-top': {from:{transform:'translateY(-160px)',opacity:0}, to:{transform:'translateY(0)',opacity:1}},
      'fly-bottom': {from:{transform:'translateY(160px)',opacity:0}, to:{transform:'translateY(0)',opacity:1}},
      'bounce': {from:{transform:'translateY(0) scale(.6)',opacity:0}, to:{transform:'translateY(0) scale(1)',opacity:1}},
      'rotate': {from:{transform:'rotate(-180deg) scale(.5)',opacity:0}, to:{transform:'rotate(0) scale(1)',opacity:1}},
      'wipe': {from:{clipPath:'inset(0 100% 0 0)',opacity:1}, to:{clipPath:'inset(0 0 0 0)',opacity:1}},
      'flip': {from:{transform:'perspective(800px) rotateY(88deg)',opacity:0}, to:{transform:'perspective(800px) rotateY(0deg)',opacity:1}},
      'blur-in': {from:{filter:'blur(14px)',opacity:0}, to:{filter:'blur(0)',opacity:1}},
      'slide-spin': {from:{transform:'translateX(-120px) rotate(-40deg) scale(.6)',opacity:0}, to:{transform:'translateX(0) rotate(0) scale(1)',opacity:1}}
    };
    var kf = kfMap[effect];
    if(!kf) return;
    var dur = parseFloat(duration) || 0.8, dly = parseFloat(delay) || 0;
    if(el.getAnimations) el.getAnimations().forEach(function(a){ a.cancel(); });
    el.animate([kf.from, kf.to], { duration: dur * 1000, delay: dly * 1000, easing: easing || 'ease', fill: 'both' });
  }

  function loop(){
    if(!isPlaying) return;
    var t = audio.currentTime;
    updateSlide(t);
    updateSubtitle(t);
    var cur = slides[currentSlide];
    if(cur){
      var slideStart = slideTimings[currentSlide] ? slideTimings[currentSlide].start : 0;
      cur.querySelectorAll('[data-zt-role="subtitle"]').forEach(function(subEl){
        var boundSel = subEl.getAttribute('data-zt-bound-to');
        if(!boundSel) return;
        var boundEl = document.querySelector(boundSel);
        if(!boundEl) return;
        var effect = boundEl.getAttribute('data-zt-anim-effect') || '';
        var absStart = slideStart + parseFloat(subEl.getAttribute('data-zt-subtitle-start') || 0);
        if(effect.indexOf('focus-') === 0 || effect === 'highlight-sweep'){
          if(!boundEl.dataset.focusDone && t >= absStart){
            boundEl.dataset.focusDone = '1';
            if(effect === 'highlight-sweep'){
              boundEl.classList.add('zt-hl-active');
            } else {
              var grp = boundEl.closest('.focus-group');
              if(grp) grp.classList.add('dim-others');
              boundEl.classList.add('zt-focus-active');
            }
          }
        } else {
          if(!boundEl.dataset.animDone && t >= absStart && t < absStart + 0.5){
            boundEl.dataset.animDone = '1';
            playAnimation(boundEl, effect, boundEl.getAttribute('data-zt-anim-duration'), boundEl.getAttribute('data-zt-anim-delay'), boundEl.getAttribute('data-zt-anim-return'), boundEl.getAttribute('data-zt-anim-easing'));
          }
        }
      });
    }
    if(audio && audio.duration) progressBar.style.width = (t / audio.duration * 100) + '%';
    requestAnimationFrame(loop);
  }

  function startPlayback(){
    if(isPlaying) return;
    audio.play().then(function(){ isPlaying = true; loop(); }).catch(function(){});
  }

  document.addEventListener('keydown', function(e){
    if(e.key === 'ArrowRight'){ e.preventDefault(); if(currentSlide < slides.length - 1){ showSlide(currentSlide + 1, true); manualOverrideUntil = Date.now() + 3000; } }
    else if(e.key === 'ArrowLeft'){ e.preventDefault(); if(currentSlide > 0){ showSlide(currentSlide - 1, true); manualOverrideUntil = Date.now() + 3000; } }
    else if(e.key === ' ' || e.code === 'Space'){ e.preventDefault(); if(!isPlaying) startPlayback(); }
  });

  document.addEventListener('click', function(e){
    if(!isPlaying){ startPlayback(); return; }
    var x = e.clientX / window.innerWidth;
    if(x > 0.5){ if(currentSlide < slides.length - 1){ showSlide(currentSlide + 1, true); manualOverrideUntil = Date.now() + 3000; } }
    else { if(currentSlide > 0){ showSlide(currentSlide - 1, true); manualOverrideUntil = Date.now() + 3000; } }
  });

  window.addEventListener('load', function(){ setTimeout(startPlayback, 300); });
  showSlide(0);
})();`

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Html-ZT-Edit 可视化编辑器 · 演示</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700;900&family=Noto+Sans+SC:wght@300;400;500;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{ --bg:#F5F0E8; --card:#FAF6F0; --ink:#2C2C2C; --red:#C41E24; --zhu:#8B3A3A; --gold:#B8860B; --line:#D4C9B8; }
  html,body{width:100%;height:100%;overflow:hidden;font-family:'Noto Sans SC',sans-serif;background:var(--bg);color:var(--ink)}
  #stage{position:relative;width:100%;height:100%}

  /* slide 用 opacity/visibility/transform 切换，与技能模板一致 */
  .slide{
    position:absolute;inset:0;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    padding:60px 80px;background:var(--bg);
    opacity:0;visibility:hidden;
    transform:translateX(30px) scale(.97);
    transition:opacity .8s ease-in-out,transform .8s ease-in-out,visibility .8s ease;
    overflow:hidden;
  }
  .slide.active{opacity:1;visibility:visible;transform:translateX(0) scale(1)}
  .slide-subtitles{display:none}

  /* 进度条 */
  #progress{position:absolute;top:0;left:0;height:5px;background:var(--red);width:0;z-index:20}

  /* 封面 */
  .cover-title{font-family:'Noto Serif SC',serif;font-weight:900;font-size:4.6rem;color:var(--ink);text-align:center;line-height:1.2}
  .cover-sub{font-size:1.6rem;color:var(--zhu);letter-spacing:.12em;margin-top:10px}
  .cover-seal{margin-top:34px;width:96px;height:96px;border-radius:50%;background:var(--red);display:flex;align-items:center;justify-content:center;transform:rotate(-8deg);box-shadow:0 8px 24px rgba(196,30,36,.25)}
  .cover-seal span{color:#fff;font-family:'Noto Serif SC',serif;font-weight:700;font-size:1rem;text-align:center;line-height:1.2}

  /* 拼贴墙飞入（纯 CSS 装饰，不入 ztEdit 动画体系） */
  .collage{position:absolute;inset:0;z-index:0}
  .collage img{position:absolute;object-fit:cover;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.55);opacity:.9;transform:rotate(var(--r,0deg));animation:flyIn .85s cubic-bezier(.22,.9,.32,1.08) backwards}
  @keyframes flyIn{0%{opacity:0;transform:translate(var(--fx,0),var(--fy,-110vh)) rotate(calc(var(--r,0deg)*4)) scale(1.3)}70%{opacity:1}100%{opacity:1;transform:translate(0,0) rotate(var(--r,0deg)) scale(1)}}
  .collage .c1{width:18%;left:3%;top:6%;--r:-8deg;--fx:-24vw;--fy:-105vh;animation-delay:.5s}
  .collage .c2{width:17%;right:4%;top:4%;--r:7deg;--fx:22vw;--fy:-110vh;animation-delay:.5s}
  .collage .c3{width:16%;left:6%;bottom:7%;--r:6deg;--fx:-26vw;--fy:105vh;animation-delay:.5s}
  .collage .c4{width:18%;right:5%;bottom:6%;--r:-6deg;--fx:24vw;--fy:108vh;animation-delay:.5s}
  .collage .c5{width:15%;left:50%;bottom:2%;--r:-2deg;--fx:0vw;--fy:115vh;animation-delay:3.5s;opacity:.7;transform:translateX(-50%) rotate(-2deg)}

  /* 内容页 */
  .lr-row{display:flex;gap:40px;align-items:center;width:100%;max-width:1280px;position:relative;z-index:2}
  .lr-left{flex:1;min-width:0}
  .lr-right{flex:1;min-width:0;display:flex;justify-content:center}
  .page-title{font-family:'Noto Serif SC',serif;font-weight:700;font-size:2.4rem;color:var(--zhu);border-left:4px solid var(--zhu);padding-left:18px;margin-bottom:24px}
  .mat-img{max-width:100%;max-height:48vh;width:auto;display:block;object-fit:contain;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.12)}

  /* 卡片（focus-group 内联动） */
  .tl-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 22px;margin-bottom:14px;font-size:1.35rem;display:flex;align-items:center;gap:14px;box-shadow:0 4px 16px rgba(0,0,0,.04)}
  .card-n{font-family:'Noto Serif SC',serif;font-weight:700;color:var(--red);font-size:1.5rem;min-width:38px}

  /* 动画演示列表/网格 */
  .demo-list{display:flex;flex-direction:column;gap:14px}
  .demo-row{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 20px;font-size:1.35rem;display:flex;align-items:center;gap:14px;box-shadow:0 4px 16px rgba(0,0,0,.04)}
  .demo-tag{font-family:'Noto Serif SC',serif;font-weight:700;color:var(--red);background:rgba(196,30,36,.08);border-radius:6px;padding:2px 10px;font-size:1rem}
  .demo-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .demo-cell{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:26px;text-align:center;font-family:'Noto Serif SC',serif;font-weight:700;font-size:1.3rem;color:var(--zhu);box-shadow:0 4px 16px rgba(0,0,0,.04)}

  /* focus 联动（与技能规范一致） */
${FOCUS_CSS}
  /* 结尾 */
  .end-wrap{width:100%;max-width:1280px;display:flex;justify-content:center}
  .end-card{background:var(--card);border-radius:36px;padding:50px 70px;text-align:center;box-shadow:0 4px 22px rgba(0,0,0,.05)}
  .end-title{font-family:'Noto Serif SC',serif;font-weight:700;font-size:2.8rem;color:var(--ink);margin-bottom:14px}
  .end-sub{color:var(--zhu);font-size:1.4rem}

  #subtitle-bar{position:absolute;bottom:46px;left:0;right:0;text-align:center;z-index:20;font-size:2.2rem;font-weight:700;color:#fff;text-shadow:0 2px 6px rgba(0,0,0,.6),0 6px 18px rgba(0,0,0,.5),0 12px 40px rgba(0,0,0,.4)}
  #hint{position:absolute;bottom:14px;left:0;right:0;text-align:center;color:#999;font-size:.9rem;z-index:20}
</style>
</head>
<body>
<div id="stage">
  <div id="progress"></div>
${slidesHTML}

  <div id="subtitle-bar"></div>
  <div id="hint">空格 / 点击播放 · ← → 翻页（同步音频）</div>
  <audio id="bgAudio" src="口播音频.mp3" preload="metadata"></audio>
</div>

<script>
${PLAYER}
</script>
</body>
</html>
`

fs.writeFileSync(outPath, html)
// 统计 + 自检
const subCount = (html.match(/data-zt-role="subtitle"/g) || []).length
const bindCount = (html.match(/data-zt-bound-to=/g) || []).length
const effects = new Set((html.match(/data-zt-anim-effect="([^"]+)"/g) || []).map((m) => m.match(/"([^"]+)"/)[1]))
console.log(`已生成 ${outPath}`)
console.log(`  页数: ${pages.length}，字幕: ${subCount} 条，绑定: ${bindCount} 条`)
console.log(`  覆盖效果(${effects.size}): ${[...effects].join(', ')}`)
