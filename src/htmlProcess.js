// HTML 预处理：剥离自动播放脚本、重写资源为 blob URL
// 以及导出时恢复资源引用 + 还原脚本

import { resolvePath } from './loadFolder.js'
import { animEngineSource } from './animEffects.js'

const ASSET_TAGS = [
  ['img', 'src'],
  ['video', 'src'],
  ['source', 'src'],
  ['audio', 'src'],
  ['link', 'href'],
  ['iframe', 'src'],
]

// 注入「音频/播放开始延迟」：把生成引擎里 `setTimeout(startPlayback, 300)` 的触发时间
// 改为 delayMs（毫秒）。延迟期间页面停在首屏（含 CSS 入场动画），delayMs 后才启动
// audio.play() + 时间轴驱动的整体播放——实现「进画面先放动画/标题，再接音频」。
// 注意：本引擎的动画时间轴就是音频时间轴（loop() 读 audio.currentTime），两者绑死，
// 所以无法做到「动画已跑、音频延后」的精细解耦；能做的只有把整体 startPlayback 延后 N 毫秒。
// delayMs <= 0 时不处理（保留引擎默认的 300ms 自动播放）。
export function injectAudioStartDelay(html, delayMs) {
  if (!html || !(delayMs > 0)) return html
  const ms = Math.max(0, Math.round(delayMs))
  return html.replace(/setTimeout\(\s*startPlayback\s*,\s*\d+\s*\)/, 'setTimeout(startPlayback, ' + ms + ')')
}

function isExternal(val) {
  return /^(https?:|data:|blob:|#|mailto:)/i.test(val || '')
}

// 剥离 <script>（编辑模式不需要自动播放，避免干扰）
// 返回去掉脚本后的 html 与脚本片段数组（导出时还原）
export function stripScripts(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const scripts = []
  doc.querySelectorAll('script').forEach((s) => {
    if (s.src) {
      scripts.push(`<script src="${s.getAttribute('src')}"></script>`)
    } else if (s.textContent && s.textContent.trim()) {
      scripts.push(`<script>${s.textContent}</script>`)
    }
    s.remove()
  })
  return { html: doc.documentElement.outerHTML, scripts }
}

// 把相对资源引用重写为 blob URL，并建立 blob -> 原始引用 的反查表（导出恢复用）
export function rewriteAssets(html, baseDir, fileMap, relMap) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const [tag, attr] of ASSET_TAGS) {
    doc.querySelectorAll(tag).forEach((el) => {
      const val = el.getAttribute(attr)
      if (!val || isExternal(val)) return
      const resolved = resolvePath(baseDir, val)
      const file = fileMap.get(resolved)
      if (file) {
        const url = URL.createObjectURL(file)
        relMap.set(url, val) // blob:url -> 原始引用字符串
        el.setAttribute(attr, url)
      }
    })
  }
  return doc.documentElement.outerHTML
}

// 清理编辑器注入物：删除编辑器样式与运行时脚本标签，并剥离 zt-grid / zt-selected 类，
// 用于草稿保存（保留用户编辑痕迹，去除编辑器自身状态）
export function stripEditorParts(html) {
  return html
    .replace(/<style id="zt-editor-style">[\s\S]*?<\/style>/g, '')
    .replace(/<script id="zt-editor-runtime">[\s\S]*?<\/script>/g, '')
    .replace(/\s+class="([^"]*)"/g, (m, cls) => {
      const cleaned = cls
        .replace(/\s*\b(zt-grid|zt-selected|zt-focus-active|zt-hl-sweep|zt-hl-active|zt-bound-mark|zt-bound-highlight|zt-binding-target|dim-others)\b\s*/g, ' ')
        .trim()
      return cleaned ? ` class="${cleaned}"` : ''
    })
}

// 导出：把 iframe 回传的 html 中的 blob URL 恢复为原始相对引用，
// 并把脚本片段还原回 body，最后包裹成完整文档
const FOCUS_CSS = '\n.focus-group .focus-item{transition:all .6s ease;position:relative}\n.focus-group.dim-others .focus-item{opacity:.35;filter:brightness(.7) blur(1px)}\n.focus-group.dim-others .focus-item.zt-focus-active{opacity:1;filter:brightness(1) blur(0);transform:scale(1.12);z-index:3;box-shadow:0 0 50px rgba(196,30,36,.35)}\n/* 组外被绑元素的独立强调：导出 HTML 里 focus-item 往往不被 .focus-group 包裹（编辑器运行时才建组），\n   激活也要有「放大+红色光晕」的正确视觉效果，而不是只剩裸 outline 红框。\n   组内规则优先级更高（带 .focus-group.dim-others 前缀），这条做兜底。 */\n.zt-focus-active{opacity:1;transform:scale(1.08);transition:all .5s cubic-bezier(.25,.9,.3,1.08);box-shadow:0 0 50px rgba(196,30,36,.55);z-index:3}\n.zt-hl-sweep{position:relative}\n.zt-hl-sweep::after{content:\'\';position:absolute;left:0;bottom:-0.18em;height:0.12em;width:100%;background:linear-gradient(90deg,#C41E24,#B8860B);border-radius:2px;transform:scaleX(0);transform-origin:left center;transition:transform .6s cubic-bezier(.25,.46,.45,.94);pointer-events:none}\n.zt-hl-sweep.zt-hl-active::after{transform:scaleX(1)}\n'

// 在产物侧剥离编辑器注入物（改的是 doc 副本，iframe 里的编辑器完全不受影响）。
//
// 这是「动画问题」的根治点：serialize() 只是把 iframe 当前 DOM 原样回传，里面带着编辑器
// 运行时脚本与编辑器样式表。而 <style id="zt-editor-style"> 的第一条规则就是
//     *{animation:none!important;transition:none!important}
// 它会被原样烤进录制/导出的 HTML —— 产物里所有 CSS 动画与过渡全部失效：
// 开场飞入不飞、文字动画不出现、焦点光晕没有过渡「直接显示」。
// 之前只在 exportClean()（导出路径）里清，录制走的是 serialize()，所以录制产物长期带着它，
// 表现为「样例工程动画不对、双击打开录屏源.html 和 OBS 录出来一个样」。
//
// 同时清掉 zt-selected / zt-bound-highlight 等编辑器状态类（红线框 outline 的来源）
// 与 dim-others（会让同组元素 opacity .35 + blur(1px)，是「画面暗/发糊」的来源之一）。
function stripEditorFromDoc(doc) {
  // 1) 编辑器注入的节点：样式表、运行时脚本、字体注入
  ;['zt-editor-style', 'zt-editor-runtime', 'zt-editor-fonts'].forEach(function (id) {
    var el = doc.getElementById(id)
    if (el && el.parentNode) el.parentNode.removeChild(el)
  })
  // 2) 编辑器状态类（只剥类，不动元素本身）
  var ZT_STATE = [
    'zt-selected', 'zt-focus-active', 'zt-bound-highlight', 'zt-bound-mark',
    'zt-binding-target', 'dim-others', 'zt-grid', 'zt-hl-sweep', 'zt-hl-active',
  ]
  try {
    doc.querySelectorAll('[class]').forEach(function (el) {
      var hit = false
      ZT_STATE.forEach(function (c) {
        if (el.classList.contains(c)) { el.classList.remove(c); hit = true }
      })
      if (hit && !el.getAttribute('class')) el.removeAttribute('class')
    })
  } catch (e) {}
  // 3) 编辑器内部 data 属性，避免污染产物
  try {
    doc.querySelectorAll('[data-zt-original-style],[data-zt-ff],[data-zt-fs],[data-zt-fw]').forEach(function (el) {
      el.removeAttribute('data-zt-original-style')
      el.removeAttribute('data-zt-ff')
      el.removeAttribute('data-zt-fs')
      el.removeAttribute('data-zt-fw')
    })
  } catch (e) {}
  // 4) 回到开场页：否则 active 停留在编辑时的当前页，与播放脚本 currentSlide=0 不一致
  try {
    var sl = doc.querySelectorAll('.slide')
    sl.forEach(function (s) { s.classList.remove('active') })
    if (sl.length) sl[0].classList.add('active')
  } catch (e) {}
}

// mapValue 可选：把「原始相对引用」改写后再回填，用于录屏页把资源指向磁盘绝对地址。
// 不传则原样还原为相对引用（导出行为，保证 edited.html 可独立分发）。
export function restoreAndWrap(iframeHtml, relMap, scripts, mapValue) {
  let html = iframeHtml
  for (const [blob, rel] of relMap.entries()) {
    const target = typeof mapValue === 'function' ? mapValue(rel) : rel
    html = html.split(blob).join(target)
  }
  const doc = new DOMParser().parseFromString(html, 'text/html')
  // 先剥离编辑器注入物与状态类，再做后续注入（顺序不能反，否则会把手写样式也误伤）
  stripEditorFromDoc(doc)
  const body = doc.body || doc.documentElement
  // 生成新播放脚本替换原脚本
  const newScript = generatePlaybackScript(scripts, html)
  for (const s of scripts) {
    // 保留外部脚本引用（如 Google Fonts）
    if (s.includes('src="')) {
      body.insertAdjacentHTML('beforeend', s)
    }
  }
  if (newScript) {
    body.insertAdjacentHTML('beforeend', '<script>' + newScript + '</scr' + 'ipt>')
  }
  // 注入聚焦强调效果所需 CSS（确保导出后 focus-group 联动可用）
  var headEl = doc.head || doc.documentElement
  headEl.insertAdjacentHTML('beforeend', '<style>' + FOCUS_CSS + '</style>')
  // 注意：不要在这里"补 focus-group"。
  // 源 HTML 的焦点组是作者显式写在 class 上的（如 <div class="tl-row focus-group" id="fg-timeline">），
  // 序列化 outerHTML 会原样保留，产物里组信息并不会丢（已实证：录屏源.html 里 fg-timeline 等组都在）。
  // 而"给每个 focus-* 元素的父容器加 focus-group"是有害的：父容器常常是 .lr-left / .lr-right /
  // .slide-content 这类大布局容器，一旦被当成组，同组内只要有任一焦点激活，
  // .focus-group.dim-others .focus-item{opacity:.35;filter:brightness(.7) blur(1px)}
  // 就会把整片区域的元素压暗并加 1px 模糊 —— 直接表现就是"画面偏暗、清晰度不高"。
  // 组只认源 HTML 的标注；没有组的元素走下面 FOCUS_CSS 的兜底规则（纯光晕、无 outline）。
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
}

function generatePlaybackScript(scripts, iframeHtml) {
  // 从原脚本中提取 slideTimings
  let slideTimingsStr = ''
  for (const s of scripts) {
    const m = s.match(/const\s+slideTimings\s*=\s*\[([\s\S]*?)\];/)
    if (m) { slideTimingsStr = 'const slideTimings=[' + m[1] + ']'; break }
  }
  if (!slideTimingsStr) return null

  return `
(function(){
// 传输层兼容垫片（非逻辑改动）：OBS 浏览器源（CEF offscreen）会把 requestAnimationFrame 节流到≈0，
// 导致 loop() 只跑一帧就冻结，而 audio.play() 由音频线程独立推进 → 录屏「画面不动、声音正常」。
// 这里把 rAF 换成 33ms 定时器，仅影响 loop 的驱动节奏；loop 内部仍读 audio.currentTime、仍走与源 HTML
// 一致的 updateSlide/updateSubtitle/focus 触发逻辑。真实浏览器里 rAF 本就正常，垫片无害。
(function(){if(window.__ztRafShim)return;window.__ztRafShim=1;var __ztRealRaf=window.requestAnimationFrame;window.requestAnimationFrame=function(cb){return setTimeout(function(){cb(performance.now?performance.now():Date.now())},33)};window.cancelAnimationFrame=function(id){clearTimeout(id)};})();

${animEngineSource()}

${slideTimingsStr}

// 别写死 bgAudio：页面可能用别的 id，取不到 audio 就会整条时间轴哑掉
// （此时画面靠 CSS 动画仍在动，很容易被误判成"录屏没声音"）
var audio=document.getElementById('bgAudio')||document.querySelector('audio');
const slides=document.querySelectorAll('.slide');
document.querySelectorAll('[data-zt-anim-effect="highlight-sweep"]').forEach(function(el){el.classList.add('zt-hl-sweep')});
// 字幕/进度条容器：源 HTML 不一定自带这两个 id（如新建项目模板、或老文件缺此结构），
// 这里做容错回退，避免 getElementById 返回 null 后 updateSubtitle 抛错把整个 loop 打断
// （表现为「双击打开不动、OBS 里只有语音没字幕」）。优先用既有 id，否则复用 #subtitle-bar，
// 再否则动态创建一个挂到 body，保证字幕一定能显示。
var subtitleEl=document.getElementById('subtitleCurrent');
if(!subtitleEl){
  subtitleEl=document.getElementById('subtitle-bar');
  if(!subtitleEl){
    subtitleEl=document.createElement('div');
    subtitleEl.id='subtitleCurrent';
    subtitleEl.style.cssText='position:absolute;bottom:46px;left:0;right:0;text-align:center;z-index:20;font-size:2.2rem;font-weight:700;color:#fff;text-shadow:0 2px 6px rgba(0,0,0,.6),0 6px 18px rgba(0,0,0,.5),0 12px 40px rgba(0,0,0,.4)';
    document.body.appendChild(subtitleEl);
  }
}
var progressBar=document.getElementById('progressBar');
if(!progressBar){progressBar=document.getElementById('progress')} // 兼容旧模板用 #progress 命名
if(!progressBar){
  progressBar=document.createElement('div');
  progressBar.id='progressBar';
  progressBar.style.cssText='position:absolute;bottom:0;left:0;height:4px;background:#C41E24;width:0;z-index:30;transition:width .2s linear';
  document.body.appendChild(progressBar);
}
let currentSlide=0,currentSubtitle=-1,isPlaying=false,manualOverrideUntil=0;

function showSlide(idx,seekAudio){
  slides.forEach(function(s,i){s.classList.remove('active');if(i===idx)s.classList.add('active')});
  currentSlide=idx;
  // 尾页三连动画（仅当页面存在 #s12 video 时生效；源 HTML 无此结构则整段不触发，与源逻辑一致）
  var v=document.querySelector('#s12 video');
  if(v){if(idx===12)v.play();else v.pause()}
  if(seekAudio&&isPlaying){
    var st=slideTimings.find(function(t){return t.slide===idx});
    if(st)audio.currentTime=st.start
  }
}

function updateSubtitle(time){
  var ns=-1;
  for(var i=0;i<subtitles.length;i++){if(time>=subtitles[i].startSec&&time<subtitles[i].endSec){ns=i;break}}
  if(ns!==currentSubtitle&&ns!==-1){
    subtitleEl.classList.add('is-changing');
    setTimeout(function(){subtitleEl.textContent=subtitles[ns].text;subtitleEl.classList.remove('is-changing')},350);
    currentSubtitle=ns
  }
}

function updateSlide(time){
  if(Date.now()<manualOverrideUntil)return;
  for(var i=slideTimings.length-1;i>=0;i--){
    if(time>=slideTimings[i].start){if(currentSlide!==slideTimings[i].slide)showSlide(slideTimings[i].slide);break}
  }
}

function loop(){
  if(!isPlaying)return;
  // 与源 HTML 逻辑一致：时间轴一律由 audio.currentTime 驱动（声画同步）。
  // 不做墙钟退化——autoplay 被拦（file:// 双击无手势）时 audio.currentTime 停在 0，
  // loop 因 isPlaying 仍为 false 不会启动，页面保持静止，等待用户空格/点击这一真实手势解锁，
  // 这与源 HTML 在 file:// 下的表现完全一致。
  var t=audio.currentTime;
  updateSlide(t);updateSubtitle(t);
  var cur=document.querySelector('.slide.active');
  if(cur){
    cur.querySelectorAll('[data-zt-role="subtitle"]').forEach(function(subEl){
      var boundSel=subEl.getAttribute('data-zt-bound-to');
      if(!boundSel)return;
      var boundEl=document.querySelector(boundSel);
      if(!boundEl)return;
      var effect=boundEl.getAttribute('data-zt-anim-effect')||'';
      var subStart=parseFloat(subEl.getAttribute('data-zt-subtitle-start'));
      var slideStart=slideTimings[currentSlide]?slideTimings[currentSlide].start:0;
      var absStart=(subStart||0)+slideStart;
      if(effect.indexOf('focus-')===0){
        if(boundEl.dataset.focusDone)return;
        if(t>=absStart){boundEl.dataset.focusDone='1';var grp=boundEl.closest('.focus-group');if(grp)grp.classList.add('dim-others');boundEl.classList.add('zt-focus-active')}
      }else{
        // 非 focus 类效果（含 highlight-sweep / zoom-in 等）一律走 playAnimation，
        // 由引擎 applyStateEffect 内部识别 highlight-sweep 并加 zt-hl-active，与源逻辑一致
        if(boundEl.dataset.animDone)return;
        if(t>=absStart&&t<absStart+0.5){boundEl.dataset.animDone='1';playAnimation(boundEl,effect,boundEl.getAttribute('data-zt-anim-duration'),boundEl.getAttribute('data-zt-anim-delay'),boundEl.getAttribute('data-zt-anim-return'),boundEl.getAttribute('data-zt-anim-easing'))}
      }
    })
  }
  if(audio && audio.duration)progressBar.style.width=(t/audio.duration*100)+'%';
  requestAnimationFrame(loop)
}

// 与源 HTML 完全一致：尝试自动播放，成功则启动 loop；被 autoplay 策略拦截则静默（.catch 吞掉），
// 页面静止，等用户空格/点击手势再次触发 startPlayback 解锁声音。OBS 浏览器源允许自动播放 → 有声有画。
function startPlayback(){
  if(isPlaying)return;
  if(!audio){isPlaying=true;loop();return}
  audio.play().then(function(){isPlaying=true;loop()}).catch(function(){})
}
document.addEventListener('keydown',function(e){
  if(e.key==='ArrowRight'){e.preventDefault();if(currentSlide<slides.length-1){showSlide(currentSlide+1,true);manualOverrideUntil=Date.now()+3000}}
  else if(e.key==='ArrowLeft'){e.preventDefault();if(currentSlide>0){showSlide(currentSlide-1,true);manualOverrideUntil=Date.now()+3000}}
  else if(e.key===' '){e.preventDefault();if(!isPlaying)startPlayback()}
});
document.addEventListener('click',function(e){
  if(!isPlaying){startPlayback();return}
  var x=e.clientX/window.innerWidth;
  if(x>0.5){if(currentSlide<slides.length-1){showSlide(currentSlide+1,true);manualOverrideUntil=Date.now()+3000}}
  else{if(currentSlide>0){showSlide(currentSlide-1,true);manualOverrideUntil=Date.now()+3000}}
});

// 手动翻页时清除动画状态
var _origShow=showSlide;showSlide=function(idx,seekAudio){_origShow(idx,seekAudio);document.querySelectorAll('.slide').forEach(function(sl){sl.querySelectorAll('[data-zt-role="subtitle"]').forEach(function(sub){var sel=sub.getAttribute('data-zt-bound-to');if(sel){var el=document.querySelector(sel);if(el){delete el.dataset.animDone;delete el.dataset.focusDone;el.classList.remove('zt-focus-active');el.classList.remove('zt-hl-active');var g=el.closest('.focus-group');if(g)g.classList.remove('dim-others')}}})})}

// 首屏入场：源 HTML 的首屏 .slide 往往写死 class="slide active"，导致 .slide 的
// translateX(30px)→0 滑入过渡在「加载即终态」时不触发（同步 remove+add 不重启动画）。
// 这里先清掉所有 active，再跨两帧把首屏 active 加回，强制触发滑入过渡（与源预览一致）。
// 在 load 前就排好，双击打开 / OBS 加载时封面都能正常滑入；时间轴动画仍等播放才开始。
;(function(){try{
  slides.forEach(function(s){s.classList.remove('active')});
  requestAnimationFrame(function(){requestAnimationFrame(function(){
    if(!document.querySelector('.slide.active'))showSlide(0)
  })})();
}catch(e){}})();

window.addEventListener('load',function(){setTimeout(startPlayback,300)});

// 读取 DOM 字幕构建 subtitles 数组
var subtitles=[];
slides.forEach(function(sl,si){
  var st=slideTimings[si];
  if(!st)return;
  sl.querySelectorAll('[data-zt-role="subtitle"]').forEach(function(el){
    var rStart=parseFloat(el.getAttribute('data-zt-subtitle-start'))||0;
    var rEnd=parseFloat(el.getAttribute('data-zt-subtitle-end'))||0;
    subtitles.push({startSec:st.start+rStart,endSec:st.start+rEnd,text:el.textContent})
  })
})
})();
`
}

