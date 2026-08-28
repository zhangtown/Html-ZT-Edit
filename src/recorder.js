// 录屏管线：捕获编辑器窗口内容 → 实时裁剪出 iframe 画布区域 → 混入页面音轨 → MediaRecorder 输出视频
// Electron：main.cjs 已注册 setDisplayMediaRequestHandler，getDisplayMedia 直接捕获本窗口，无选择框
// 浏览器：退回系统窗口/标签页选择框，仍可录制

// 按浏览器支持度挑选封装格式（优先 mp4，退回 webm）
function pickMime() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
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

// 开始录制。iframeEl：画布 iframe；返回 { stop() -> Promise<{blob, ext}>, canvas }
export async function startRecording(iframeEl) {
  if (!iframeEl) throw new Error('画布尚未加载')
  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
    audio: false,
    // Chromium：优先当前标签页（Electron 中由主进程直接接管，不弹选择框）
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
  })

  const video = document.createElement('video')
  video.muted = true
  video.srcObject = displayStream
  await video.play()
  if (video.readyState < 1) {
    await new Promise((r) => { video.onloadedmetadata = r })
  }

  // 实时裁剪：把捕获画面按 iframe 在视口中的位置裁出来
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  let raf = 0
  let stopped = false
  function draw() {
    if (stopped) return
    const rect = iframeEl.getBoundingClientRect()
    // 视口尺寸兜底：异常环境（innerWidth=0）下退化为 1:1 映射
    const vw = window.innerWidth || document.documentElement.clientWidth || video.videoWidth
    const vh = window.innerHeight || document.documentElement.clientHeight || video.videoHeight
    const kx = video.videoWidth / vw
    const ky = video.videoHeight / vh
    const w = Math.max(2, Math.round(rect.width * kx))
    const h = Math.max(2, Math.round(rect.height * ky))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    ctx.drawImage(video, rect.left * kx, rect.top * ky, w, h, 0, 0, w, h)
    raf = requestAnimationFrame(draw)
  }
  draw()

  const outStream = canvas.captureStream(30)

  // 混入 iframe 内音频元素的音轨（演讲音频）
  try {
    const doc = iframeEl.contentDocument
    const audioEl = doc && (doc.getElementById('bgAudio') || doc.querySelector('audio'))
    if (audioEl && audioEl.captureStream) {
      audioEl
        .captureStream()
        .getAudioTracks()
        .forEach((t) => outStream.addTrack(t))
    }
  } catch (e) {}

  const mime = pickMime()
  const rec = new MediaRecorder(
    outStream,
    mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined
  )
  const chunks = []
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data)
  }
  rec.start(1000)

  // 用户在系统 UI 上主动停止了共享 → 视同停止录制
  let onInactive = null
  const inactivePromise = new Promise((r) => { onInactive = r })
  displayStream.getVideoTracks()[0]?.addEventListener('ended', () => onInactive && onInactive())

  return {
    canvas,
    // stop 返回最终视频；用户外部停止共享时也会自动走 stop 逻辑（由调用方兜底）
    onExternalStop: inactivePromise,
    stop: () =>
      new Promise((resolve) => {
        const finish = () => {
          stopped = true
          cancelAnimationFrame(raf)
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
