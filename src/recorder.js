// 录屏管线
// 主路径（Electron）：主进程开一个定尺寸的隐藏窗口跑时间轴，getDisplayMedia 直接捕获它，
//   输出分辨率与编辑器窗口大小彻底解耦，也不再有 canvas 逐帧裁剪的开销。
// 兜底路径（纯浏览器 / 拿不到资源根目录）：退回捕获编辑器窗口 + 按 iframe 位置裁剪。
// 音频一律从编辑器 iframe 里的 <audio> 混入（离屏页那份被静音，只贡献画面）。

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
    if (audioEl && audioEl.captureStream) {
      audioEl
        .captureStream()
        .getAudioTracks()
        .forEach((t) => stream.addTrack(t))
    }
  } catch (e) {}
}

// 开始录制
// iframeEl：编辑器画布 iframe（提供音轨；兜底模式下同时决定裁剪区域）
// opts：{ offscreen, width, height }
export async function startRecording(iframeEl, opts) {
  if (!iframeEl) throw new Error('画布尚未加载')
  const o = opts || {}
  const offscreen = !!o.offscreen
  const W = Math.round(Number(o.width) || 1920)
  const H = Math.round(Number(o.height) || 1080)

  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30, width: W, height: H },
    // 离屏模式：音频随画面一起从离屏窗口捕获（音画同源，零偏移）。
    // 关掉 AGC/降噪/回声消除，否则口播人声会被"处理"得发闷。
    audio: offscreen
      ? {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
        }
      : false,
    // Chromium：优先当前标签页（Electron 中由主进程直接接管，不弹选择框）
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
  })

  const vTrack = displayStream.getVideoTracks()[0]
  const st = vTrack && vTrack.getSettings ? vTrack.getSettings() : {}
  const srcW = Math.round(st.width || 0)
  const srcH = Math.round(st.height || 0)
  // 系统缩放（DPR≠1）会让捕获尺寸偏离目标，此时才需要重采样兜底
  const needScale = offscreen && (srcW !== W || srcH !== H)

  let outStream
  let raf = 0
  let stopped = false
  let canvas = null

  if (offscreen && !needScale) {
    // 理想路径：捕获尺寸就是目标分辨率，直接录，不建 video、不逐帧拷贝。
    // 这里要带上 audio 轨——它就是离屏窗口的声音，与画面同源。
    outStream = new MediaStream(displayStream.getTracks())
  } else {
    const video = document.createElement('video')
    video.muted = true
    video.srcObject = displayStream
    await video.play()
    if (video.readyState < 1) {
      await new Promise((r) => { video.onloadedmetadata = r })
    }
    canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (needScale) {
      canvas.width = W
      canvas.height = H
    }
    const draw = () => {
      if (stopped) return
      if (needScale) {
        ctx.drawImage(video, 0, 0, W, H)
      } else {
        // 兜底：按 iframe 在视口中的位置裁出画布区域
        const rect = iframeEl.getBoundingClientRect()
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
      }
      raf = requestAnimationFrame(draw)
    }
    draw()
    outStream = canvas.captureStream(30)
    if (offscreen) {
      // 走了重采样兜底，画面重绘过，但音频仍是离屏页那份，直接接上
      displayStream.getAudioTracks().forEach((t) => outStream.addTrack(t))
    }
  }

  // 仅兜底模式需要从编辑器 iframe 取音轨：那时捕获的是编辑器窗口，拿不到页面音频
  if (!offscreen) mixInAudio(outStream, iframeEl)

  const mime = pickMime()
  const rec = new MediaRecorder(
    outStream,
    mime ? { mimeType: mime, videoBitsPerSecond: 12_000_000 } : undefined
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
    offscreen,
    // 真正送进 MediaRecorder 的音轨数：0 就说明这趟注定没声音，调用方据此告警
    audioTrackCount: outStream.getAudioTracks().length,
    // stop 返回最终视频；用户外部停止共享时也会自动走 stop 逻辑（由调用方兜底）
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
