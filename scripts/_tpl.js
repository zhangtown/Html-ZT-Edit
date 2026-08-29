
(function(){
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
    case 'flip': return { from: { transform: 'perspective(900px) rotateY(88deg) scale(0.94)', opacity: 0 }, to: { transform: 'perspective(900px) rotateY( 0deg) scale(1)', opacity: 1 } }
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
    } else { el.classList.add('zt-hl-active') }
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

const slideTimings=[{slide:0,start:0,end:12.1},{slide:1,start:12.1,end:53},{slide:2,start:53,end:99},{slide:3,start:99,end:146},{slide:4,start:146,end:180},{slide:5,start:180,end:210},{slide:6,start:210,end:238},{slide:7,start:238,end:250},{slide:8,start:250,end:294},{slide:9,start:294,end:330},{slide:10,start:330,end:350},{slide:11,start:350,end:362}];
const audio=document.getElementById('bgAudio');
const slides=document.querySelectorAll('.slide');
const subtitleEl=document.getElementById('subtitleCurrent');
const progressBar=document.getElementById('progressBar');
let currentSlide=0,currentSubtitle=-1,isPlaying=false,manualOverrideUntil=0;
function showSlide(idx,seekAudio){
  slides.forEach(function(s,i){s.classList.remove('active');if(i===idx)s.classList.add('active')});
  currentSlide=idx;
  if(seekAudio&&isPlaying){var st=slideTimings.find(function(t){return t.slide===idx});if(st)audio.currentTime=st.start}
}
function updateSubtitle(time){
  var ns=-1;
  for(var i=0;i<subtitles.length;i++){if(time>=subtitles[i].startSec&&time<subtitles[i].endSec){ns=i;break}}
  if(ns!==currentSubtitle&&ns!==-1){
    subtitleEl.classList.add('is-changing');
    setTimeout(function(){subtitleEl.textContent=subtitles[ns].text;subtitleEl.classList.remove('is-changing')},350);
    currentSubtitle=ns;
  }
}
function updateSlide(time){
  if(Date.now()<manualOverrideUntil)return;
  for(var i=slideTimings.length-1;i>=0;i--){if(time>=slideTimings[i].start){if(currentSlide!==slideTimings[i].slide)showSlide(slideTimings[i].slide);break}}
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
      if(!boundEl)return;
      var effect=boundEl.getAttribute('data-zt-anim-effect')||'';
      var subStart=parseFloat(subEl.getAttribute('data-zt-subtitle-start'));
      var slideStart=slideTimings[currentSlide]?slideTimings[currentSlide].start:0;
      var absStart=(subStart||0)+slideStart;
      if(effect.indexOf('focus-')===0){
        if(boundEl.dataset.focusDone)return;
        if(t>=absStart){boundEl.dataset.focusDone='1';var grp=boundEl.closest('.focus-group');if(grp)grp.classList.add('dim-others');boundEl.classList.add('zt-focus-active')}
      }else{
        if(boundEl.dataset.animDone)return;
        if(t>=absStart&&t<absStart+0.5){boundEl.dataset.animDone='1';playAnimation(boundEl,effect,boundEl.getAttribute('data-zt-anim-duration'),boundEl.getAttribute('data-zt-anim-delay'),boundEl.getAttribute('data-zt-anim-return'),boundEl.getAttribute('data-zt-anim-easing'))}
      }
    });
  }
  if(audio.duration)progressBar.style.width=(t/audio.duration*100)+'%';
  requestAnimationFrame(loop);
}
function startPlayback(){if(isPlaying)return;audio.play().then(function(){isPlaying=true;loop()}).catch(function(){})}
var _origShow=showSlide;showSlide=function(idx,seekAudio){_origShow(idx,seekAudio);document.querySelectorAll('.slide').forEach(function(sl){sl.querySelectorAll('[data-zt-role="subtitle"]').forEach(function(sub){var sel=sub.getAttribute('data-zt-bound-to');if(sel){var el=document.querySelector(sel);if(el){delete el.dataset.animDone;delete el.dataset.focusDone;el.classList.remove('zt-focus-active','zt-hl-active','zt-hl-sweep');var g=el.closest('.focus-group');if(g)g.classList.remove('dim-others')}}})})}
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
window.addEventListener('load',function(){setTimeout(startPlayback,300)});
var subtitles=[];
slides.forEach(function(sl,si){
  var st=slideTimings[si];if(!st)return;
  sl.querySelectorAll('[data-zt-role="subtitle"]').forEach(function(el){
    var rStart=parseFloat(el.getAttribute('data-zt-subtitle-start'))||0;
    var rEnd=parseFloat(el.getAttribute('data-zt-subtitle-end'))||0;
    subtitles.push({startSec:st.start+rStart,endSec:st.start+rEnd,text:el.textContent});
  });
});
})();
