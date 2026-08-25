// HTML 预处理：剥离自动播放脚本、重写资源为 blob URL
// 以及导出时恢复资源引用 + 还原脚本

import { resolvePath } from './loadFolder.js'

const ASSET_TAGS = [
  ['img', 'src'],
  ['video', 'src'],
  ['source', 'src'],
  ['audio', 'src'],
  ['link', 'href'],
  ['iframe', 'src'],
]

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
        .replace(/\s*\b(zt-grid|zt-selected)\b\s*/g, ' ')
        .trim()
      return cleaned ? ` class="${cleaned}"` : ''
    })
}

// 导出：把 iframe 回传的 html 中的 blob URL 恢复为原始相对引用，
// 并把脚本片段还原回 body，最后包裹成完整文档
export function restoreAndWrap(iframeHtml, relMap, scripts) {
  let html = iframeHtml
  for (const [blob, rel] of relMap.entries()) {
    html = html.split(blob).join(rel)
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
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
}

function getEffectKeyframesCode() {
  return `
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
    default: return { from: { transform: 'scale(1)' }, to: { transform: 'scale(1.2)' } }
  }
}`
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
${getEffectKeyframesCode()}

function playAnimation(el, effect, duration, delay, returnSec, easing) {
  if (!el) return
  var kf = getEffectKeyframes(effect || 'zoom-in')
  var dur = parseFloat(duration) || 1
  var dly = parseFloat(delay) || 0
  var ret = parseFloat(returnSec) || 0
  var ease = easing || 'ease'
  var totalDur = dur + ret
  var keyframes = []
  if (dly > 0) keyframes.push({ offset: 0, transform: 'scale(1)', opacity: 1 })
  var startOff = dly > 0 ? dly / totalDur : 0
  var endOff = (dly + dur) / totalDur
  keyframes.push({ offset: startOff, transform: kf.from.transform, opacity: kf.from.opacity != null ? kf.from.opacity : 1 })
  keyframes.push({ offset: endOff, transform: kf.to.transform, opacity: kf.to.opacity != null ? kf.to.opacity : 1 })
  if (ret > 0) keyframes.push({ offset: 1, transform: 'scale(1)', opacity: 1 })
  el.animate(keyframes, { duration: totalDur * 1000, easing: ease, fill: 'forwards' })
}

${slideTimingsStr}

const audio=document.getElementById('bgAudio');
const slides=document.querySelectorAll('.slide');
const subtitleEl=document.getElementById('subtitleCurrent');
const progressBar=document.getElementById('progressBar');
let currentSlide=0,currentSubtitle=-1,isPlaying=false,manualOverrideUntil=0;

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
  var t=audio.currentTime;
  updateSlide(t);updateSubtitle(t);
  var cur=document.querySelector('.slide.active');
  if(cur){
    cur.querySelectorAll('[data-zt-role="subtitle"]').forEach(function(subEl){
      var boundSel=subEl.getAttribute('data-zt-bound-to');
      if(!boundSel)return;
      var boundEl=document.querySelector(boundSel);
      if(!boundEl||boundEl.dataset.animDone)return;
      var subStart=parseFloat(subEl.getAttribute('data-zt-subtitle-start'));
      var slideStart=slideTimings[currentSlide]?slideTimings[currentSlide].start:0;
      var absStart=(subStart||0)+slideStart;
      if(t>=absStart&&t<absStart+0.5){
        boundEl.dataset.animDone='1';
        var effect=boundEl.getAttribute('data-zt-anim-effect');
        var duration=boundEl.getAttribute('data-zt-anim-duration');
        var delay=boundEl.getAttribute('data-zt-anim-delay');
        var returnSec=boundEl.getAttribute('data-zt-anim-return');
        var easing=boundEl.getAttribute('data-zt-anim-easing');
        playAnimation(boundEl,effect,duration,delay,returnSec,easing)
      }
    })
  }
  if(audio.duration)progressBar.style.width=(t/audio.duration*100)+'%';
  requestAnimationFrame(loop)
}

function startPlayback(){if(isPlaying)return;audio.play().then(function(){isPlaying=true;loop()}).catch(function(){})}

// 手动翻页时清除动画状态
var _origShow=showSlide;showSlide=function(idx,seekAudio){_origShow(idx,seekAudio);document.querySelectorAll('.slide').forEach(function(sl){sl.querySelectorAll('[data-zt-role="subtitle"]').forEach(function(sub){var sel=sub.getAttribute('data-zt-bound-to');if(sel){var el=document.querySelector(sel);if(el)delete el.dataset.animDone}})})}

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

