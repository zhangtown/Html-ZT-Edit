// 录屏管线 v3.2：直接全屏 + 原生分辨率优先 + WebCodecs 编码引擎
// 路线：点录制 → 编辑器窗口全屏（画面即所得）→ getDisplayMedia 捕获主窗口 →
//   默认原生分辨率直出（仅补齐到 16 对齐，零缩放零黑边）→ mp4(H.264 High+AAC)。
//
// 为什么默认原生：v3 固定 1080P 档在 2520×1680（3:2）屏上要缩小 ~35% 再加黑边，
//   文字细节明显发虚（用户对标 Game Bar 实测结论）。原生直出 = Game Bar 同款清晰度。
// 为什么仍过 canvas：H.264 硬编码器要求宽 16 对齐，屏幕分辨率五花八门
//   （2520×1680 实测 "Video encoding failed"）；canvas 输出尺寸补齐到 16 后，
//   任何显示器/比例/DPI 行为完全一致。原生档 1:1 直绘不经过缩放滤镜，无清晰度损失。
// 固定档位（1080P/2K/4K）保留：想要小文件时手动选，行为同 v3（等比缩放+信箱）。
// 为什么不用离屏定尺寸窗口：已弃用——离屏页里第三方播放脚本时序不可控（gate 放行后
//   播放循环不启动，画面冻结在第一页），还多出临时文件/隐藏窗口两层复杂度。
// 音轨：从编辑器 iframe 的 <audio> captureStream 直取——它就是屏幕上正在播放的
//   同一实例，与画面同源；主窗口的音频捕获轨实测是静音数据，不可用。
//
// v3.2 为什么改用 WebCodecs 编码（2026-08-31 实测定案）：
//   MediaRecorder 的 videoBitsPerSecond 在部分机器上基本失效——同一台机器实测
//   （Electron 31 / Chromium 126，硬编软编都试过）：H.264 请求 1M~16.7M 实际只出
//   0.3~4.9Mbps，VP8/VP9/H.264 × var/constant 全部如此，25 秒成片仅 ~5MB，文字发虚。
//   换 WebCodecs VideoEncoder（bitrateMode:'constant'）后同机实测：请求 16.7M
//   实出 16.7M（静/动画面都兑现），AAC AudioEncoder 可用。
// v3.2.1 回退默认引擎（2026-08-31）：WebCodecs 路径视频完美但音轨在本机全零静音
//   （收包/AAC 块数正常、电平 0.0000；AudioContext 钉 48k 与默认采样率都复现），
//   而 MediaRecorder 消费同一条 WebAudio 轨在另一台电脑有声。故默认引擎回退
//   MediaRecorder（=fe38419 行为，有声保底），WebCodecs 留开关待查静音根因
//   （localStorage.setItem('ztWebCodecs','1') 可临时打开；在别的机器上如有声，
//   即可判定是本机音频环境问题而非代码问题）。

import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

// 按浏览器支持度挑选封装格式（优先 mp4/H.264 High Profile+AAC，退回 webm）
// High(640028)/Main(4D4028) 带 CABAC，同码率下细节明显好于 Baseline(42E01E)；
// Chromium 会按平台能力自动降级，链尾兜底保证总能起录
// Chromium 126（Electron 31）起 MediaRecorder 原生支持 mp4 封装
function pickMime() {
  const candidates = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.4D4028,mp4a.40.2',
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

// WebCodecs 引擎开关：默认关闭（MediaRecorder 兜底成为默认引擎，行为=fe38419，有声有保证）。
// 为什么默认关：本机实测 WebCodecs 路径视频 16.7M 足额、但音轨全零静音（收包/AAC 正常、电平 0.0000，
// 48k/默认采样率都复现）；MediaRecorder 消费同一条 WebAudio 轨在另一台电脑有声。
// 临时打开验证（DevTools Console）：localStorage.setItem('ztWebCodecs','1') 后刷新
const USE_WEBCODECS = (() => {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem('ztWebCodecs') === '1' } catch (e) { return false }
})()

// 供 UI 显示当前能出什么格式
// MediaRecorder 默认：Electron 31(Chromium 126) 本身支持 mp4/H.264；WebCodecs 开关打开时显示 WebCodecs 档
export function probeMime() {
  if (USE_WEBCODECS && typeof window !== 'undefined' && window.VideoEncoder && window.MediaStreamTrackProcessor) {
    return { mime: 'video/mp4;codecs=avc1.640028,mp4a.40.2', ext: 'mp4', engine: 'webcodecs' }
  }
  const m = pickMime()
  return { mime: m, ext: m && m.indexOf('mp4') >= 0 ? 'mp4' : 'webm', engine: 'mediarecorder' }
}

// 取可录制的音轨：WebAudio 管线（元素一播放就出数据帧，可控性最好）。
// 返回 { track, sampleRate, channels, via }，找不到可用音频时返回 null。
// （实测 element.captureStream() 在元素尚未播放时拿到的轨不会产出数据帧，
//   mp4 里连音轨 box 都不会写——它只作为 MediaRecorder 兜底的最后手段，
//   WebCodecs 路径不用它，因为拿不到确定的采样率/声道数，AAC 配置会错。）
function getAudioTrack(iframeEl) {
  try {
    const doc = iframeEl && iframeEl.contentDocument
    const audioEl = doc && (doc.getElementById('bgAudio') || doc.querySelector('audio'))
    if (!audioEl) {
      console.warn(
        '[ZT-Edit] 页面里没找到 <audio>，本次录制将无声。' +
          '诊断：iframe doc=' + !!doc + '，body子元素数=' + (doc && doc.body ? doc.body.children.length : -1)
      )
      return null
    }
    console.warn(
      '[ZT-Edit] 音频元素已找到 src=' + (audioEl.currentSrc || audioEl.src || '(空)') +
        ' paused=' + audioEl.paused + ' readyState=' + audioEl.readyState +
        ' 已有缓存dest=' + !!audioEl.__ztRecDest
    )
    try {
      if (audioEl.__ztRecDest) {
        // createMediaElementSource 对同一元素只能调一次：复用首次建好的 destination。
        // context 必须强引用+复用时 resume：录制结束后失去引用可能被 GC/自动挂起，
        // 挂起状态下音轨无数据（"第一次录有声、编辑后再录无声"的实证形态）。
        const ctx = audioEl.__ztRecCtx
        if (ctx && ctx.state === 'suspended') {
          ctx.resume().catch((e) => console.warn('[ZT-Edit] AudioContext resume 失败：' + (e && e.message)))
        }
        const track = audioEl.__ztRecDest.stream.getAudioTracks()[0]
        console.warn('[ZT-Edit] 音轨(WebAudio·复用)已取得, ctxState=' + (ctx ? ctx.state : 'unknown'))
        return track ? { track, sampleRate: ctx.sampleRate, channels: audioEl.__ztRecDest.channelCount || 2, via: 'webaudio' } : null
      }
      // 采样率用设备默认（与 v3.1 一致）：曾钉 48000 导致本机实录全零静音（另一台电脑默认采样率有声）；
      // AAC/封装配置直接用 ctx 实际采样率，44.1k/48k 都合法
      const actx = new (window.AudioContext || window.webkitAudioContext)()
      console.warn('[ZT-Edit] AudioContext 已创建 state=' + actx.state + ' sampleRate=' + actx.sampleRate)
      const resumeP = actx.state === 'suspended' ? actx.resume().catch((e) => console.warn('[ZT-Edit] AudioContext resume 失败：' + (e && e.message))) : null
      const src = actx.createMediaElementSource(audioEl)
      const dest = actx.createMediaStreamDestination()
      src.connect(dest)
      // createMediaElementSource 会把元素输出改道 WebAudio，必须接回扬声器，否则编辑器里没声
      src.connect(actx.destination)
      audioEl.__ztRecDest = dest
      audioEl.__ztRecCtx = actx // 强引用防 GC；下次录制复用时按需 resume
      const track = dest.stream.getAudioTracks()[0]
      console.warn('[ZT-Edit] 音轨(WebAudio)已取得 track=' + (track && track.readyState) + ' muted=' + (track && track.muted))
      if (resumeP) resumeP.then(() => console.warn('[ZT-Edit] AudioContext resume 后 state=' + actx.state)).catch(() => {})
      return track ? { track, sampleRate: actx.sampleRate, channels: dest.channelCount || 2, via: 'webaudio' } : null
    } catch (e) {
      console.warn('[ZT-Edit] WebAudio 音轨取得失败：' + (e && e.message))
    }
    if (audioEl.captureStream) {
      const t = audioEl.captureStream().getAudioTracks()[0]
      if (t) {
        console.warn('[ZT-Edit] 音轨(captureStream兜底)已取得，仅用于 MediaRecorder 路径')
        return { track: t, sampleRate: 0, channels: 0, via: 'capture' }
      }
    }
  } catch (e) {}
  return null
}

// 开始录制
// iframeEl：编辑器画布 iframe（音轨来源）
// opts：{ width, height } 固定输出档位（须为 16 对齐）；不给或为 0 → 原生分辨率直出
export async function startRecording(iframeEl, opts) {
  if (!iframeEl) throw new Error('画布尚未加载')
  const o = opts || {}
  const tierW = Math.round(Number(o.width) || 0)
  const tierH = Math.round(Number(o.height) || 0)
  const fixedTier = tierW >= 16 && tierH >= 16

  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    // 不约束捕获尺寸：窗口多大捕多大，输出尺寸在下方决定
    video: { frameRate: 30 },
    // 窗口音轨实测是静音数据（原因未明，离屏窗口同写法则有声）；音轨走 getAudioTrack
    audio: false,
    // Chromium：优先当前标签页（Electron 中由主进程直接接管，不弹选择框）
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
  })

  const vTrack = displayStream.getVideoTracks()[0]
  const st = vTrack && vTrack.getSettings ? vTrack.getSettings() : {}
  // 细节优先：UI/文字画面告诉编码器把码率花在锐度上而不是运动平滑
  try { vTrack.contentHint = 'detail' } catch (e) {}

  // 捕获流 → video 元素 → canvas 绘制（原生档 1:1 直绘；固定档等比缩放信箱）
  const video = document.createElement('video')
  video.muted = true
  video.srcObject = displayStream
  await video.play()
  if (video.readyState < 1) {
    await new Promise((r) => { video.onloadedmetadata = r })
  }
  const vw = video.videoWidth || 1920
  const vh = video.videoHeight || 1080

  // 输出尺寸：固定档照旧；原生档 = 捕获原生像素向上补齐到 16（H.264 硬编对齐要求），
  // 只加 ≤15px 黑边、内容零缩放——2520×1680 → 2528×1680
  const W = fixedTier ? Math.max(16, tierW) : Math.max(16, Math.ceil(vw / 16) * 16)
  const H = fixedTier ? Math.max(16, tierH) : Math.max(16, Math.ceil(vh / 16) * 16)

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  let raf = 0
  let stopped = false
  // 原生档强制 k=1：绝不放大缩小；固定档维持 v3 等比信箱逻辑
  const scale = fixedTier ? Math.min(W / vw, H / vh) : 1
  const draw = () => {
    if (stopped) return
    const dw = Math.max(2, Math.round(vw * scale))
    const dh = Math.max(2, Math.round(vh * scale))
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    ctx.drawImage(video, Math.floor((W - dw) / 2), Math.floor((H - dh) / 2), dw, dh)
    raf = requestAnimationFrame(draw)
  }
  draw()

  // 码率按输出像素走：1080p≈17M、原生2.5K≈32M、4K 封顶 48M（对标 Game Bar 高码率；
  // WebCodecs CBR 会足额兑现；MediaRecorder 引擎不认高码率时会被钳到上限，不会失败）
  const bitrate = Math.min(48_000_000, Math.max(12_000_000, Math.round(W * H * 8)))
  // 编码器初始化需要几百毫秒，这期间产不出任何样本；录制若在这之前就被停掉，
  // 成片只有骨架没有样本——录制时长必须作为自检第一项，它比音轨电平更能说明问题。
  const startedAt = performance.now()
  const audioInfo = getAudioTrack(iframeEl)

  // 用户在系统 UI 上主动停止了共享 → 视同停止录制。
  // 带上"距启动多少毫秒"：全屏切换的余波会让捕获轨在录制刚起步时就 ended，
  // 与用户真的手动停止共享是两种完全不同的情况，调用方据此区分处理。
  let onInactive = null
  const inactivePromise = new Promise((r) => { onInactive = r })
  displayStream.getVideoTracks()[0]?.addEventListener('ended', () => {
    const at = Math.round(performance.now() - startedAt)
    console.warn(`[ZT-Edit] 捕获轨 ended，距录制启动 ${at}ms`)
    if (onInactive) onInactive(at)
  })

  const cleanup = () => {
    stopped = true
    if (raf) cancelAnimationFrame(raf)
    try { displayStream.getTracks().forEach((t) => t.stop()) } catch (e) {}
  }

  // ① WebCodecs 引擎（可选，见 USE_WEBCODECS 注释）：视频 CBR 精确码率；音频在本机实测静音待查
  const wc = USE_WEBCODECS ? await canUseWebCodecs(W, H, bitrate) : null
  if (wc) {
    return buildWebCodecsSession({ canvas, W, H, bitrate, codec: wc, audioInfo, startedAt, inactivePromise, cleanup })
  }

  // ② MediaRecorder 兜底（无 WebCodecs 的环境）：码率是否兑现取决于内核，无法保证
  const outStream = canvas.captureStream(30)
  if (audioInfo) {
    try { outStream.addTrack(audioInfo.track) } catch (e) {}
  }
  const mime = pickMime()
  const rec = new MediaRecorder(
    outStream,
    mime ? { mimeType: mime, videoBitsPerSecond: bitrate } : undefined
  )
  const chunks = []
  let recError = null
  let firstChunkAt = 0
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) {
      if (!firstChunkAt) firstChunkAt = performance.now()
      chunks.push(e.data)
    }
  }
  rec.onerror = (e) => {
    const err = e && e.error
    recError = err ? `${err.name}: ${err.message}` : String(e)
    console.error('[ZT-Edit] MediaRecorder 错误：' + recError)
  }
  rec.onstop = () => console.warn(`[ZT-Edit] 录制器停止：共 ${chunks.length} 块数据`)
  rec.start(1000)
  console.warn(
    `[ZT-Edit] 录制器已启动 [MediaRecorder兜底] [${fixedTier ? '固定档' : '原生直出'}] 输出=${W}x${H} 源=${vw}x${vh} ` +
      `mime=${mime || '默认'} bitrate=${bitrate} 送入轨数(v/a)=${outStream.getVideoTracks().length}/${outStream.getAudioTracks().length}`
  )

  return {
    canvas,
    direct: true,
    engine: 'mediarecorder',
    audioTrackCount: outStream.getAudioTracks().length,
    videoTrackCount: outStream.getVideoTracks().length,
    onExternalStop: inactivePromise,
    stop: () =>
      new Promise((resolve) => {
        const finish = () => {
          cleanup()
          try { outStream.getTracks().forEach((t) => t.stop()) } catch (e) {}
          const ext = mime && mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm'
          resolve({
            blob: new Blob(chunks, { type: mime || 'video/webm' }),
            ext,
            durationMs: Math.round(performance.now() - startedAt),
            recError,
            firstChunkMs: firstChunkAt ? Math.round(firstChunkAt - startedAt) : 0,
          })
        }
        if (rec.state === 'inactive') finish()
        else {
          rec.onstop = finish
          try { rec.stop() } catch (e) { finish() }
        }
      }),
  }
}

// WebCodecs 可用性：High → Main → Baseline 依次探测，返回可用 codec 串或 null
async function canUseWebCodecs(W, H, bitrate) {
  try {
    if (typeof window === 'undefined' || !window.VideoEncoder || !window.MediaStreamTrackProcessor) return null
    for (const codec of ['avc1.640028', 'avc1.4D4028', 'avc1.42E01E']) {
      const s = await VideoEncoder.isConfigSupported({
        codec, width: W, height: H, bitrate, framerate: 30,
        bitrateMode: 'constant', latencyMode: 'quality',
      })
      if (s && s.supported) return codec
    }
  } catch (e) {
    console.warn('[ZT-Edit] WebCodecs 探测失败，走 MediaRecorder：' + (e && e.message))
  }
  return null
}

// WebCodecs 录制会话：canvas 轨 → VideoEncoder(H.264 CBR)，WebAudio 轨 → AudioEncoder(AAC)，
// mp4-muxer 封装成单一 mp4。stop() 返回契约与 MediaRecorder 路径一致。
function buildWebCodecsSession({ canvas, W, H, bitrate, codec, audioInfo, startedAt, inactivePromise, cleanup }) {
  let recError = null
  let firstChunkAt = 0
  const canvasTrack = canvas.captureStream(30).getVideoTracks()[0]

  // 音频只收 WebAudio 来源（采样率/声道数确定，AAC 与封装配置才不会错）
  const audio = audioInfo && audioInfo.via === 'webaudio' && window.AudioEncoder ? audioInfo : null
  if (audioInfo && !audio) {
    console.warn('[ZT-Edit] 音轨非 WebAudio 来源或无 AudioEncoder，本趟按无声处理')
  }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H },
    ...(audio ? { audio: { codec: 'aac', sampleRate: audio.sampleRate, numberOfChannels: audio.channels } } : {}),
    fastStart: 'in-memory',
  })

  const venc = new VideoEncoder({
    output: (chunk, meta) => {
      if (!firstChunkAt) firstChunkAt = performance.now()
      muxer.addVideoChunk(chunk, meta)
    },
    error: (e) => {
      recError = `VideoEncoder: ${e && e.message}`
      console.error('[ZT-Edit] VideoEncoder 错误：' + recError)
    },
  })
  venc.configure({
    codec, width: W, height: H, bitrate, framerate: 30,
    // constant 是清晰度问题的正解：variable 模式在本机实测 16.7M 请求只花 0.3~1.5M
    bitrateMode: 'constant',
    latencyMode: 'quality',
    avc: { format: 'avc' }, // mp4 封装需要 avcC 描述（随 chunk meta 带出）
  })

  // 视频泵：canvas 轨 → VideoFrame → 编码器；编码队列积压 >8 帧时丢帧保实时
  const vReader = new MediaStreamTrackProcessor({ track: canvasTrack }).readable.getReader()
  let frameIdx = 0
  let dropped = 0
  const vPump = (async () => {
    try {
      while (true) {
        const { done, value: frame } = await vReader.read()
        if (done) break
        if (venc.state !== 'configured') { frame.close(); break }
        if (venc.encodeQueueSize > 8) { frame.close(); dropped++; continue }
        venc.encode(frame, { keyFrame: frameIdx % 60 === 0 })
        frame.close()
        frameIdx++
      }
    } catch (e) {
      recError = recError || ('video pump: ' + (e && e.message))
    }
  })()

  // 音频泵：WebAudio 轨 → AudioData → AAC
  let aenc = null
  let aPump = null
  let audioDataCount = 0
  let aacChunkCount = 0
  if (audio) {
    try {
      aenc = new AudioEncoder({
        output: (chunk, meta) => { aacChunkCount++; muxer.addAudioChunk(chunk, meta) },
        error: (e) => console.error('[ZT-Edit] AudioEncoder 错误：' + (e && e.message)),
      })
      aenc.configure({ codec: 'mp4a.40.2', sampleRate: audio.sampleRate, numberOfChannels: audio.channels, bitrate: 192000 })
      const aReader = new MediaStreamTrackProcessor({ track: audio.track }).readable.getReader()
      aPump = (async () => {
        try {
          while (true) {
            const { done, value } = await aReader.read()
            if (done) break
            if (aenc.state !== 'configured') { if (value.close) value.close(); break }
            aenc.encode(value)
            if (value.close) value.close()
            audioDataCount++
          }
        } catch (e) {
          console.warn('[ZT-Edit] 音频泵中断：' + (e && e.message))
        }
      })()
    } catch (e) {
      console.warn('[ZT-Edit] AAC 初始化失败，本趟无声：' + (e && e.message))
      aenc = null
    }
  }

  console.warn(
    `[ZT-Edit] 录制器已启动 [WebCodecs] 输出=${W}x${H} codec=${codec} bitrate=${bitrate}(CBR)` +
      ` 送入轨数(v/a)=1/${aenc ? 1 : 0}`
  )

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  return {
    canvas,
    direct: true,
    engine: 'webcodecs',
    audioTrackCount: aenc ? 1 : 0,
    videoTrackCount: 1,
    onExternalStop: inactivePromise,
    stop: () =>
      new Promise((resolve) => {
        (async () => {
          try { canvasTrack.stop() } catch (e) {}
          await Promise.race([vPump, sleep(1500)])
          try { await Promise.race([venc.flush(), sleep(3000)]); venc.close() } catch (e) {}
          if (aPump) await Promise.race([aPump, sleep(1000)])
          if (aenc) {
            try { await Promise.race([aenc.flush(), sleep(3000)]); aenc.close() } catch (e) {}
          }
          try { muxer.finalize() } catch (e) { recError = recError || ('mp4 finalize: ' + (e && e.message)) }
          cleanup()
          if (dropped) console.warn(`[ZT-Edit] 编码背压丢帧 ${dropped} 帧`)
          console.warn(`[ZT-Edit] 音频统计：AudioData收包=${audioDataCount} AAC块=${aacChunkCount}`)
          resolve({
            blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }),
            ext: 'mp4',
            durationMs: Math.round(performance.now() - startedAt),
            recError,
            firstChunkMs: firstChunkAt ? Math.round(firstChunkAt - startedAt) : 0,
            audioDataCount,
            aacChunkCount,
          })
        })()
      }),
  }
}
