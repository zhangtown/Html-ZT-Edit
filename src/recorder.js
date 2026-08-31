// 录屏管线 v3.3：直接全屏 + 原生分辨率优先 + WebCodecs 编码引擎 + MediaRecorder 音频链路
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
// v3.2.1 曾回退默认引擎到 MediaRecorder：WebCodecs 路径视频完美但音轨全零静音。
// v3.3 静音根因定案（2026-08-31）——不是音频环境问题，是采集方式选错了：
//   静音的两版都用「主线程读 PCM」：先是 MediaStreamTrackProcessor 消费 WebAudio 轨
//   （收包正常、内容全零），后是 ScriptProcessor.onaudioprocess（一次回调都没触发，
//   实测成片音轨 stsz sample_count=0，见 scripts/mp4probe.py）。两者的共性是都要在
//   主线程上被调度，而录制期间主线程被 rAF 重绘 + VideoEncoder.encode + muxer 占满，
//   音频回调直接饿死。MediaRecorder 的采集在浏览器内部线程完成，不受影响，
//   且这条链路本机已实锤有声。故 WebCodecs 只管视频（保清晰度），
//   音频交给 MediaRecorder 独立采集、录完解码成 PCM 再编 AAC，最后交错封装。

import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import { getAudioTrack, startAudioCapture, encodeAudioToAac } from './recAudio'

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

// WebCodecs 引擎开关：默认开启（清晰度是硬需求，v3.3 音频链路已修好，不再是「清晰度和声音二选一」）。
// 关掉退回 MediaRecorder 兜底（DevTools Console）：localStorage.setItem('ztWebCodecs','0') 后刷新。
// 注意判定只能写成 === '0'：早先误写成 !== '0'，导致没设过开关的默认情形反而是「开」，
// 与注释和提交意图相反，用户因此静默跑在了当时还有静音缺陷的 WebCodecs 路径上。
const USE_WEBCODECS = (() => {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem('ztWebCodecs') === '0' ? false : true } catch (e) { return true }
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

  // ① WebCodecs 引擎（默认）：视频 CBR 足额码率保清晰度；音频走 MediaRecorder 独立采集
  const wc = USE_WEBCODECS ? await canUseWebCodecs(W, H, bitrate) : null
  if (wc) {
    return buildWebCodecsSession({ canvas, W, H, bitrate, codec: wc, iframeEl, startedAt, inactivePromise, cleanup })
  }

  // ② MediaRecorder 兜底（无 WebCodecs 或开关未开）：码率是否兑现取决于内核，无法保证
  const outStream = canvas.captureStream(30)
  const audioInfo = getAudioTrack(iframeEl)
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


// WebCodecs 录制会话：canvas 轨 → VideoEncoder(H.264 CBR)；
// 音频走 MediaRecorder 独立采集（主线程读 PCM 的两种做法都会被视频管线饿死，见文件头 v3.3 注释）。
// 音频必须录完才编得出来，所以视频 chunk 先缓存，stop() 时再与 AAC 交错封装成单一 mp4。
function buildWebCodecsSession({ canvas, W, H, bitrate, codec, iframeEl, startedAt, inactivePromise, cleanup }) {
  let recError = null
  let firstChunkAt = 0
  const canvasTrack = canvas.captureStream(30).getVideoTracks()[0]

  // 视频 chunk 缓存（等音频编好一起交错封装）。内存代价 ≈ 成片大小，
  // 超过 400MB 打个警告：再长就要考虑分片封装或降级 MediaRecorder 了。
  const vChunks = []
  let vBytes = 0

  // 音频：MediaRecorder 采集在浏览器内部线程完成，不受主线程阻塞
  const audioCap = startAudioCapture(iframeEl)

  const venc = new VideoEncoder({
    output: (chunk, meta) => {
      if (!firstChunkAt) firstChunkAt = performance.now()
      vChunks.push({ chunk, meta })
      vBytes += chunk.byteLength || 0
      if (vBytes > 400 * 1024 * 1024) {
        console.warn('[ZT-Edit] 视频 chunk 缓存已超过 400MB，长录制建议改选固定 1080P 档降低码率')
      }
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

  console.warn(
    `[ZT-Edit] 录制器已启动 [WebCodecs] 输出=${W}x${H} codec=${codec} bitrate=${bitrate}(CBR)` +
      ` 音频采集=${audioCap ? audioCap.kind : '无（本趟无声）'}`
  )

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  return {
    canvas,
    direct: true,
    engine: 'webcodecs',
    // 音频有没有轨要等录完编码完才知道，这里先标采集器是否挂上
    audioTrackCount: audioCap ? 1 : 0,
    videoTrackCount: 1,
    onExternalStop: inactivePromise,
    stop: () =>
      new Promise((resolve) => {
        (async () => {
          try { canvasTrack.stop() } catch (e) {}
          // 音频必须和视频同时停：晚停一秒，成片音轨就比画面长一秒（尾端拖一段空白）。
          // 这里只发起停止（rec.stop() 是同步生效的），真正的解码+编码放到视频 flush 之后 await，
          // 正好和视频收尾并行，不给用户多等。
          const audioStopping = audioCap ? audioCap.stop() : null

          await Promise.race([vPump, sleep(1500)])
          try { await Promise.race([venc.flush(), sleep(3000)]); venc.close() } catch (e) {}

          // 音频收尾：MediaRecorder blob → 解码 PCM → AAC
          let audio = { chunks: [], sampleRate: 0, channels: 0, pcmFrames: 0, error: '未挂音频采集器' }
          if (audioStopping) {
            try {
              const aBlob = await audioStopping
              audio = await encodeAudioToAac(aBlob)
            } catch (e) {
              audio = { chunks: [], sampleRate: 0, channels: 0, pcmFrames: 0, error: '音频收尾异常：' + (e && e.message) }
            }
          }

          // 封装：两条轨各自成 stbl，交错写入后 finalize。
          // 音频一块都没有就别建音轨——空的 soun 轨会让「产物含音轨」误报成是。
          let blob = new Blob([], { type: 'video/mp4' })
          try {
            const muxer = new Muxer({
              target: new ArrayBufferTarget(),
              video: { codec: 'avc', width: W, height: H },
              ...(audio.chunks.length
                ? { audio: { codec: 'aac', sampleRate: audio.sampleRate, numberOfChannels: audio.channels } }
                : {}),
              fastStart: 'in-memory',
            })
            // 按时间戳交错写入：mp4-muxer 非分片模式下两条轨各自累积，
            // 调用顺序不影响正确性，但交错能让 mdat 里音视频数据交替排布，
            // 播放器拖进度条时不用在文件头尾之间来回跳。
            const all = [
              ...vChunks.map((c) => ({ t: c.chunk.timestamp, video: true, c })),
              ...audio.chunks.map((c) => ({ t: c.chunk.timestamp, video: false, c })),
            ].sort((a, b) => a.t - b.t)
            for (const it of all) {
              if (it.video) muxer.addVideoChunk(it.c.chunk, it.c.meta)
              else muxer.addAudioChunk(it.c.chunk, it.c.meta)
            }
            muxer.finalize()
            blob = new Blob([muxer.target.buffer], { type: 'video/mp4' })
          } catch (e) {
            recError = recError || ('mp4 finalize: ' + (e && e.message))
          }
          cleanup()
          if (dropped) console.warn(`[ZT-Edit] 编码背压丢帧 ${dropped} 帧`)
          console.warn(
            `[ZT-Edit] 收尾统计：视频chunk=${vChunks.length}(${(vBytes / 1048576).toFixed(1)}MB) ` +
              `音频PCM帧=${audio.pcmFrames} AAC块=${audio.chunks.length}${audio.error ? ' 音频错误=' + audio.error : ''}`
          )
          resolve({
            blob,
            ext: 'mp4',
            durationMs: Math.round(performance.now() - startedAt),
            recError,
            firstChunkMs: firstChunkAt ? Math.round(firstChunkAt - startedAt) : 0,
            // 诊断字段：PCM 帧数 / AAC 块数 / 音频链路状态
            audioDataCount: audio.pcmFrames,
            aacChunkCount: audio.chunks.length,
            audioError: audio.error,
            audioKind: audioCap ? audioCap.kind : 'none',
          })
        })()
      }),
  }
}
