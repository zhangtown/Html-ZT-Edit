// 录屏管线 v3：直接全屏 + 固定输出分辨率
// 路线：点录制 → 编辑器窗口全屏（画面即所得）→ getDisplayMedia 捕获主窗口 →
//   canvas 等比重采样到固定输出档位（默认 1920×1080）→ mp4(H.264+AAC)。
//
// 为什么不直录屏幕原始像素：H.264 硬编码器要求宽 16 对齐，屏幕分辨率五花八门
//   （2520×1680 实测 "Video encoding failed"，1920×1080 正常）；固定 16 对齐的
//   输出档位后，任何显示器/比例/DPI 行为完全一致，码率也恒定。
// 为什么不用离屏定尺寸窗口：已弃用——离屏页里第三方播放脚本时序不可控（gate 放行后
//   播放循环不启动，画面冻结在第一页），还多出临时文件/隐藏窗口两层复杂度。
// 音轨：从编辑器 iframe 的 <audio> captureStream 直取——它就是屏幕上正在播放的
//   同一实例，与画面同源；主窗口的音频捕获轨实测是静音数据，不可用。

// 按浏览器支持度挑选封装格式（优先 mp4/H.264+AAC，退回 webm）
// Chromium 126（Electron 31）起 MediaRecorder 原生支持 mp4 封装
function pickMime() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1.4D4028,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ]
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m
    } catch (e) {}
  }
  return ''
}

// 供 UI 显示当前能出什么格式
export function probeMime() {
  const m = pickMime()
  return { mime: m, ext: m && m.indexOf('mp4') >= 0 ? 'mp4' : 'webm' }
}

function mixInAudio(stream, iframeEl) {
  try {
    const doc = iframeEl && iframeEl.contentDocument
    const audioEl = doc && (doc.getElementById('bgAudio') || doc.querySelector('audio'))
    if (!audioEl) {
      console.warn(
        '[ZT-Edit] 页面里没找到 <audio>，本次录制将无声。' +
          '诊断：iframe doc=' + !!doc + '，body子元素数=' + (doc && doc.body ? doc.body.children.length : -1)
      )
      return
    }
    console.warn(
      '[ZT-Edit] 音频元素已找到 src=' + (audioEl.currentSrc || audioEl.src || '(空)') +
        ' paused=' + audioEl.paused + ' readyState=' + audioEl.readyState +
        ' 已有缓存dest=' + !!audioEl.__ztRecDest
    )
    // 首选 WebAudio 管线：元素一播放就出数据帧，可控性最好。
    // （实测 element.captureStream() 在元素尚未播放时拿到的轨不会产出数据帧，
    //   mp4 里连音轨 box 都不会写——它是踩过坑的兜底，不再是首选。）
    try {
      if (audioEl.__ztRecDest) {
        // createMediaElementSource 对同一元素只能调一次：复用首次建好的 destination。
        // context 必须强引用+复用时 resume：录制结束后失去引用可能被 GC/自动挂起，
        // 挂起状态下音轨无数据（"第一次录有声、编辑后再录无声"的实证形态）。
        const ctx = audioEl.__ztRecCtx
        if (ctx && ctx.state === 'suspended') {
          ctx.resume().catch((e) => console.warn('[ZT-Edit] AudioContext resume 失败：' + (e && e.message)))
        }
        const st2 = ctx ? ctx.state : 'unknown'
        audioEl.__ztRecDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t))
        console.warn('[ZT-Edit] 音轨(WebAudio·复用)已接入, ctxState=' + st2 + ', tracks=' + stream.getAudioTracks().length)
        return
      }
      const actx = new (window.AudioContext || window.webkitAudioContext)()
      console.warn('[ZT-Edit] AudioContext 已创建 state=' + actx.state)
      const resumeP = actx.state === 'suspended' ? actx.resume().catch((e) => console.warn('[ZT-Edit] AudioContext resume 失败：' + (e && e.message))) : null
      const src = actx.createMediaElementSource(audioEl)
      const dest = actx.createMediaStreamDestination()
      src.connect(dest)
      // createMediaElementSource 会把元素输出改道 WebAudio，必须接回扬声器，否则编辑器里没声
      src.connect(actx.destination)
      audioEl.__ztRecDest = dest
      audioEl.__ztRecCtx = actx // 强引用防 GC；下次录制复用时按需 resume
      dest.stream.getAudioTracks().forEach((t) => {
        stream.addTrack(t)
        console.warn('[ZT-Edit] 音轨(WebAudio)已接入 track=' + t.readyState + ' muted=' + t.muted)
      })
      if (resumeP) resumeP.then(() => console.warn('[ZT-Edit] AudioContext resume 后 state=' + actx.state)).catch(() => {})
      return
    } catch (e) {
      console.warn('[ZT-Edit] WebAudio 音轨接入失败，退回 captureStream：' + (e && e.message))
    }
    if (audioEl.captureStream) {
      audioEl.captureStream().getAudioTracks().forEach((t) => stream.addTrack(t))
      console.warn('[ZT-Edit] 音轨(captureStream兜底)已接入')
    }
  } catch (e) {}
}

// 开始录制
// iframeEl：编辑器画布 iframe（音轨来源）
// opts：{ width, height } 输出分辨率（默认 1920×1080，须为 16 对齐档位）
export async function startRecording(iframeEl, opts) {
  if (!iframeEl) throw new Error('画布尚未加载')
  const o = opts || {}
  const W = Math.max(16, Math.round(Number(o.width) || 1920))
  const H = Math.max(16, Math.round(Number(o.height) || 1080))

  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    // 不约束捕获尺寸：窗口多大捕多大，重采样交给 canvas
    video: { frameRate: 30 },
    // 窗口音轨实测是静音数据（原因未明，离屏窗口同写法则有声）；音轨走 mixInAudio
    audio: false,
    // Chromium：优先当前标签页（Electron 中由主进程直接接管，不弹选择框）
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
  })

  const vTrack = displayStream.getVideoTracks()[0]
  const st = vTrack && vTrack.getSettings ? vTrack.getSettings() : {}

  // 捕获流 → video 元素 → canvas 等比缩放居中（非 16:9 屏幕自动信箱）
  const video = document.createElement('video')
  video.muted = true
  video.srcObject = displayStream
  await video.play()
  if (video.readyState < 1) {
    await new Promise((r) => { video.onloadedmetadata = r })
  }

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  let raf = 0
  let stopped = false
  const draw = () => {
    if (stopped) return
    const vw = video.videoWidth || W
    const vh = video.videoHeight || H
    const k = Math.min(W / vw, H / vh)
    const dw = Math.max(2, Math.round(vw * k))
    const dh = Math.max(2, Math.round(vh * k))
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    ctx.drawImage(video, Math.floor((W - dw) / 2), Math.floor((H - dh) / 2), dw, dh)
    raf = requestAnimationFrame(draw)
  }
  draw()
  const outStream = canvas.captureStream(30)
  mixInAudio(outStream, iframeEl)

  const mime = pickMime()
  // 码率按输出档位走：1080p≈12Mbps；20Mbps 封顶（再高部分硬编码器不认）
  const bitrate = Math.min(20_000_000, Math.max(12_000_000, Math.round(W * H * 5.8)))
  const rec = new MediaRecorder(
    outStream,
    mime ? { mimeType: mime, videoBitsPerSecond: bitrate } : undefined
  )
  const chunks = []
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data)
  }
  rec.onerror = (e) => {
    const err = e && e.error
    console.error(
      '[ZT-Edit] MediaRecorder 错误：' +
        (err ? `${err.name}: ${err.message}` : String(e))
    )
  }
  rec.onstop = () => console.warn(`[ZT-Edit] 录制器停止：共 ${chunks.length} 块数据`)
  rec.start(1000)
  console.warn(
    `[ZT-Edit] 录制器已启动 输出=${W}x${H} 源=${st.width || '?'}x${st.height || '?'} ` +
      `mime=${mime || '默认'} bitrate=${bitrate}`
  )

  // 用户在系统 UI 上主动停止了共享 → 视同停止录制
  let onInactive = null
  const inactivePromise = new Promise((r) => { onInactive = r })
  displayStream.getVideoTracks()[0]?.addEventListener('ended', () => onInactive && onInactive())

  return {
    canvas,
    direct: true,
    // 真正送进 MediaRecorder 的音轨数：0 就说明这趟注定没声音，调用方据此告警
    audioTrackCount: outStream.getAudioTracks().length,
    // 用户在系统层面停止共享时轨道会 ended，调用方据此兜底结束录制
    onExternalStop: inactivePromise,
    stop: () =>
      new Promise((resolve) => {
        const finish = () => {
          stopped = true
          if (raf) cancelAnimationFrame(raf)
          try { displayStream.getTracks().forEach((t) => t.stop()) } catch (e) {}
          try { outStream.getTracks().forEach((t) => t.stop()) } catch (e) {}
          const ext = mime && mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm'
          resolve({ blob: new Blob(chunks, { type: mime || 'video/webm' }), ext })
        }
        if (rec.state === 'inactive') finish()
        else {
          rec.onstop = finish
          try { rec.stop() } catch (e) { finish() }
        }
      }),
  }
}
