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
const FOCUS_CSS = '\n.focus-group .focus-item{transition:all .6s ease;position:relative}\n.focus-group.dim-others .focus-item{opacity:.35;filter:brightness(.7) blur(1px)}\n.focus-group.dim-others .focus-item.zt-focus-active{opacity:1;filter:brightness(1) blur(0);transform:scale(1.12);z-index:3;box-shadow:0 0 50px rgba(196,30,36,.35)}\n/* 组外被绑元素的独立强调：导出 HTML 里 focus-item 往往不被 .focus-group 包裹（编辑器运行时才建组），\n   激活也要有「放大+红色光晕」的正确视觉效果，而不是只剩裸 outline 红框。\n   组内规则优先级更高（带 .focus-group.dim-others 前缀），这条做兜底。 */\n.zt-focus-active{outline:2px solid rgba(196,30,36,.5);outline-offset:2px;opacity:1;transform:scale(1.08);transition:all .5s cubic-bezier(.25,.9,.3,1.08);box-shadow:0 0 40px rgba(196,30,36,.4);z-index:3}\n.zt-hl-sweep{position:relative}\n.zt-hl-sweep::after{content:\'\';position:absolute;left:0;bottom:-0.18em;height:0.12em;width:100%;background:linear-gradient(90deg,#C41E24,#B8860B);border-radius:2px;transform:scaleX(0);transform-origin:left center;transition:transform .6s cubic-bezier(.25,.46,.45,.94);pointer-events:none}\n.zt-hl-sweep.zt-hl-active::after{transform:scaleX(1)}\n'

// 录屏专用 mapper：把相对引用改写成 file:// 绝对地址。
// 录屏页是系统临时目录里的 HTML，只有指回磁盘原位置才能加载到图片/音频。
// rootDir 为空（浏览器模式）时原样返回，调用方会退回窗口捕获方案。
export function fileUrlMapper(rootDir) {
  const base = String(rootDir || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return function (rel) {
    if (!base) return rel
    if (/^(https?:|data:|blob:|#|mailto:|\/)/i.test(rel || '')) return rel
    const segs = String(rel).replace(/\\/g, '/').split('/').filter(Boolean)
    if (!segs.length) return rel
    const full = base + '/' + segs.join('/')
    return 'file:///' + full.split('/').map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/')
  }
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
// OBS 浏览器源（CEF offscreen）会把 requestAnimationFrame 节流到≈0，导致 loop() 只跑一帧就冻结，
// 而 audio.play() 由音频线程独立推进 → 录屏「画面不动、声音正常」。这里注入 rAF→setTimeout 垫片：
// 在 OBS 里 loop 改走 33ms 定时器持续推进画面；真实 Edge 里 rAF 本就正常，垫片不影响其行为。
(function(){if(window.__ztRafShim)return;window.__ztRafShim=1;var __ztRealRaf=window.requestAnimationFrame;window.requestAnimationFrame=function(cb){return setTimeout(function(){cb(performance.now?performance.now():Date.now())},33)};window.cancelAnimationFrame=function(id){clearTimeout(id)};})();

${animEngineSource()}

${slideTimingsStr}

// 别写死 bgAudio：页面可能用别的 id，取不到 audio 就会整条时间轴哑掉
// （此时画面靠 CSS 动画仍在动，很容易被误判成"录屏没声音"）
var audio=document.getElementById('bgAudio')||document.querySelector('audio');
const slides=document.querySelectorAll('.slide');
document.querySelectorAll('[data-zt-anim-effect="highlight-sweep"]').forEach(function(el){el.classList.add('zt-hl-sweep')});
var subtitleEl=document.getElementById('subtitleCurrent');
var progressBar=document.getElementById('progressBar');
let currentSlide=0,currentSubtitle=-1,isPlaying=false,manualOverrideUntil=0;
// 音频不可用时的退化计时基准：autoplay 被拦 / 页面无 <audio> / 无音轨时，
// loop 改走墙钟（performance.now）推进时间轴，画面照常播放（无声）。
// 有声时 loop 优先用 audio.currentTime，这条基准只在退化路径生效。
var __ztClockBase=0;

function showSlide(idx,seekAudio){
  slides.forEach(function(s,i){s.classList.remove('active');if(i===idx)s.classList.add('active')});
  currentSlide=idx;
  // 尾页三连动画
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
  // 时间轴来源：有声且正在播 → 用 audio.currentTime（声画同步）；
  // 否则退化到墙钟（autoplay 被拦 / 无 <audio> / 无音轨 / file:// 双击无手势）→ 画面照常推进（无声）。
  var t;
  if(audio && !audio.paused && isFinite(audio.duration) && audio.duration>0){ t=audio.currentTime }
  else { t=(performance.now()-__ztClockBase)/1000 }
  if(!isFinite(t))t=0;
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
      }else if(effect==='highlight-sweep'){
        if(boundEl.dataset.focusDone)return;
        if(t>=absStart){boundEl.dataset.focusDone='1';if(!boundEl.classList.contains('zt-hl-sweep'))boundEl.classList.add('zt-hl-sweep');requestAnimationFrame(function(){requestAnimationFrame(function(){boundEl.classList.add('zt-hl-active')})})}
      }else{
        if(boundEl.dataset.animDone)return;
        if(t>=absStart&&t<absStart+0.5){boundEl.dataset.animDone='1';var duration=boundEl.getAttribute('data-zt-anim-duration');var delay=boundEl.getAttribute('data-zt-anim-delay');var returnSec=boundEl.getAttribute('data-zt-anim-return');var easing=boundEl.getAttribute('data-zt-anim-easing');var grp=boundEl.closest('.focus-group');if(grp){grp.classList.remove('dim-others');boundEl.classList.remove('zt-focus-active')}playAnimation(boundEl,effect,duration,delay,returnSec,easing)}
      }
    })
  }
  if(audio && audio.duration)progressBar.style.width=(t/audio.duration*100)+'%';
  requestAnimationFrame(loop)
}

function startPlayback(){
  if(isPlaying)return;
  var begin=function(){isPlaying=true;__ztClockBase=performance.now();loop()};
  try{
    if(!audio){begin();return}
    var p=audio.play();
    if(p&&p.then)p.then(begin).catch(begin); // autoplay 被拦 → 退化墙钟，无声也播放
    else begin()
  }catch(e){begin()} // 无 audio / play() 抛错 → 退化墙钟
}

// 手动翻页时清除动画状态
var _origShow=showSlide;showSlide=function(idx,seekAudio){_origShow(idx,seekAudio);document.querySelectorAll('.slide').forEach(function(sl){sl.querySelectorAll('[data-zt-role="subtitle"]').forEach(function(sub){var sel=sub.getAttribute('data-zt-bound-to');if(sel){var el=document.querySelector(sel);if(el){delete el.dataset.animDone;delete el.dataset.focusDone;el.classList.remove('zt-focus-active');el.classList.remove('zt-hl-active');var g=el.closest('.focus-group');if(g)g.classList.remove('dim-others')}}})})}

document.addEventListener('keydown',function(e){
  if(e.key==='ArrowRight'){e.preventDefault();if(currentSlide<slides.length-1){showSlide(currentSlide+1,true);manualOverrideUntil=Date.now()+3000}}
  else if(e.key==='ArrowLeft'){e.preventDefault();if(currentSlide>0){showSlide(currentSlide-1,true);manualOverrideUntil=Date.now()+3000}}
  else if(e.key===' '){e.preventDefault();if(!isPlaying)startPlayback()}
})

document.addEventListener('click',function(e){
  if(!isPlaying){startPlayback();return}
  var x=e.clientX/window.innerWidth;
  if(x>0.5){if(currentSlide<slides.length-1){showSlide(currentSlide+1,true);manualOverrideUntil=Date.now()+3000}}
  else{if(currentSlide>0){showSlide(currentSlide-1,true);manualOverrideUntil=Date.now()+3000}}
})

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

