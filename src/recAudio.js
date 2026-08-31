// 录屏音轨采集：WebAudio 图 → MediaRecorder(webm/opus) → 解码 PCM → AAC
//
// ---------------------------------------------------------------------------
// 为什么音频必须走 MediaRecorder，不能在主线程读 PCM
// ---------------------------------------------------------------------------
// 实测两种「主线程读音频数据」的方案在录制期间都拿不到东西：
//   ① MediaStreamTrackProcessor 消费 WebAudio 的 MediaStreamDestination 轨：
//      收包数正常，但内容全零；
//   ② ScriptProcessor.onaudioprocess：一次回调都没触发（成片音轨 stsz count=0）。
// 共性：两者都要在主线程（或主线程泵）上被调度，而录制期间主线程被
//   rAF 重绘（原生档 2520×1680 的 drawImage）+ VideoEncoder.encode + muxer 写盘
//   彻底占满，音频回调被饿死。分辨率越高、帧越大，饿得越死。
// MediaRecorder 的采集在浏览器内部线程完成，不受主线程阻塞影响；
//   而且这条链路本机已实锤有声（旧分支产物音轨有真实电平，只是码率低画面糊）。
//
// 代价：音频要等录制结束才能编码，所以视频 chunk 必须缓存到 stop() 再统一封装。
//   短片（30s~2min）内存可接受；超长录制见 recorder.js 里的内存保护阈值。
//
// 复用规则：createMediaElementSource 对同一个 <audio> 元素只能调用一次，
//   调用第二次会抛 InvalidStateError。所以 AudioContext/源节点/目标节点全部按
//   「元素身份」缓存；元素换了（iframe 重载、切换文件）就释放旧图重建——
//   AudioContext 数量在 Chromium 里约 6 个，不 close 会耗尽配额。

// MediaRecorder 音频封装候选：opus/webm 是 Chromium 最稳的一条
const AUDIO_MIMES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
]

function pickAudioMime() {
  for (const m of AUDIO_MIMES) {
    try {
      if (window.MediaRecorder && window.MediaRecorder.isTypeSupported(m)) return m
    } catch (e) {}
  }
  return ''
}

let gCtx = null
let gSrc = null
let gDest = null
let gBoundEl = null

function releaseGraph() {
  try {
    if (gCtx) gCtx.close()
  } catch (e) {}
  gCtx = null
  gSrc = null
  gDest = null
  gBoundEl = null
}

// 建立（或复用）WebAudio 图。返回 null 表示页面里没有可用音源。
function ensureGraph(iframeEl) {
  try {
    const doc = iframeEl && iframeEl.contentDocument
    const audioEl = doc && (doc.getElementById('bgAudio') || doc.querySelector('audio'))
    if (!audioEl) {
      console.warn('[ZT-Edit] 页面里没找到 <audio>，本次录制将无声。')
      return null
    }
    if (gCtx && gBoundEl === audioEl) {
      if (gCtx.state === 'suspended') {
        gCtx.resume().catch((e) => console.warn('[ZT-Edit] AudioContext resume 失败：' + (e && e.message)))
      }
      return { ctx: gCtx, dest: gDest }
    }
    // 元素身份变了：旧图连着已经失效的元素，必须释放再建
    releaseGraph()
    const Ctx = window.AudioContext || window.webkitAudioContext
    const ctx = new Ctx()
    const src = ctx.createMediaElementSource(audioEl)
    const dest = ctx.createMediaStreamDestination()
    src.connect(dest)
    // createMediaElementSource 会把元素输出改道 WebAudio，必须接回扬声器，
    // 否则编辑器里点播放听不到声音
    src.connect(ctx.destination)
    gCtx = ctx
    gSrc = src
    gDest = dest
    gBoundEl = audioEl
    console.warn('[ZT-Edit] 音频图已建立 state=' + ctx.state + ' sampleRate=' + ctx.sampleRate)
    if (ctx.state === 'suspended') {
      ctx.resume().catch((e) => console.warn('[ZT-Edit] AudioContext resume 失败：' + (e && e.message)))
    }
    return { ctx, dest }
  } catch (e) {
    console.warn('[ZT-Edit] 音频图建立失败，本趟无声：' + (e && e.message))
    return null
  }
}

// 直接取活音轨（给 MediaRecorder 视频路径 addTrack 用）。
// 与 startAudioCapture 共用同一张 WebAudio 图——两条路径都走已实锤有声的这条链路。
// 返回 { track, sampleRate, channels }；无音源时返回 null。
export function getAudioTrack(iframeEl) {
  const g = ensureGraph(iframeEl)
  if (!g) return null
  const track = g.dest.stream.getAudioTracks()[0]
  if (!track) return null
  return { track, sampleRate: g.ctx.sampleRate, channels: g.dest.channelCount || 2 }
}

// 开始采集音频：MediaRecorder 录 WebAudio 轨 → webm/opus
// 返回 { kind, sampleRate, channels, stop(): Promise<Blob> }；无音源时返回 null
export function startAudioCapture(iframeEl) {
  const g = ensureGraph(iframeEl)
  if (!g) return null
  const track = g.dest.stream.getAudioTracks()[0]
  if (!track) {
    console.warn('[ZT-Edit] WebAudio 目标流里没有音轨，本趟无声。')
    return null
  }
  const mime = pickAudioMime()
  let rec
  try {
    rec = new window.MediaRecorder(new MediaStream([track]), mime ? { mimeType: mime } : undefined)
  } catch (e) {
    console.warn('[ZT-Edit] 音频 MediaRecorder 创建失败，本趟无声：' + (e && e.message))
    return null
  }
  const chunks = []
  let recError = null
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data)
  }
  rec.onerror = (e) => {
    recError = e && e.error ? `${e.error.name}: ${e.error.message}` : String(e)
    console.error('[ZT-Edit] 音频 MediaRecorder 错误：' + recError)
  }
  const stopped = new Promise((resolve) => {
    rec.onstop = () => resolve()
  })
  rec.start(500)
  console.warn('[ZT-Edit] 音频采集已启动 mime=' + (mime || '默认') + ' sampleRate=' + g.ctx.sampleRate)

  return {
    kind: 'mediarecorder',
    sampleRate: g.ctx.sampleRate,
    channels: g.dest.channelCount || 2,
    mime,
    get error() {
      return recError
    },
    stop: () =>
      new Promise((resolve) => {
        const collect = () => new Blob(chunks, { type: mime || 'audio/webm' })
        // MediaRecorder 偶尔不触发 onstop（轨提前 ended 等），留 2s 兜底强制收口
        const timer = setTimeout(() => resolve(collect()), 2000)
        stopped.then(() => {
          clearTimeout(timer)
          resolve(collect())
        })
        try {
          if (rec.state === 'inactive') {
            clearTimeout(timer)
            resolve(collect())
          } else {
            rec.stop()
          }
        } catch (e) {
          clearTimeout(timer)
          resolve(collect())
        }
      }),
  }
}

// webm/opus blob → 解码 PCM → AAC chunks（供 mp4-muxer 与视频交错封装）
// 返回 { chunks: [{chunk, meta}], sampleRate, channels, pcmFrames, error }
export async function encodeAudioToAac(blob) {
  const empty = { chunks: [], sampleRate: 0, channels: 0, pcmFrames: 0, error: '无音频数据' }
  try {
    if (!blob || !blob.size) return { ...empty, error: '音频 blob 为空（采集没产出数据）' }
    if (!window.AudioEncoder) return { ...empty, error: '当前环境不支持 AudioEncoder' }
    const buf = await blob.arrayBuffer()
    const Ctx = window.AudioContext || window.webkitAudioContext
    const ctx = new Ctx()
    let ab
    try {
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume()
        } catch (e) {}
      }
      ab = await ctx.decodeAudioData(buf)
    } finally {
      // AudioContext 不 close 会一直占着内核配额（约 6 个），录几次后就再也建不出来
      try {
        ctx.close()
      } catch (e) {}
    }
    const nch = Math.max(1, Math.min(2, ab.numberOfChannels))
    const frames = ab.length
    if (!frames) return { ...empty, error: '解码后音频长度为 0' }
    // 先拼成 planar Float32（AudioData 的 f32-planar 要求 [ch0全帧][ch1全帧]）
    const planar = new Float32Array(frames * nch)
    for (let c = 0; c < nch; c++) planar.set(ab.getChannelData(c), c * frames)

    const chunks = []
    const aenc = new window.AudioEncoder({
      output: (chunk, meta) => chunks.push({ chunk, meta }),
      error: (e) => console.error('[ZT-Edit] AudioEncoder 错误：' + (e && e.message)),
    })
    aenc.configure({ codec: 'mp4a.40.2', sampleRate: ab.sampleRate, numberOfChannels: nch, bitrate: 192000 })
    const BLOCK = 4096
    let off = 0
    while (off < frames) {
      const n = Math.min(BLOCK, frames - off)
      const data = new Float32Array(n * nch)
      for (let c = 0; c < nch; c++) {
        data.set(planar.subarray(c * frames + off, c * frames + off + n), c * n)
      }
      // 成员名是 numberOfFrames，不是 sampleFrames（后者是 AudioEncoder 那侧的叫法）。
      // 写错会抛 "Failed to read the 'numberOfFrames' property from 'AudioDataInit':
      // Required member is undefined"，整条音频链路因此产出 0 个 AAC 块。
      const ad = new window.AudioData({
        format: 'f32-planar',
        numberOfFrames: n,
        numberOfChannels: nch,
        sampleRate: ab.sampleRate,
        timestamp: Math.round((off * 1e6) / ab.sampleRate),
        data,
      })
      aenc.encode(ad)
      ad.close()
      off += n
    }
    try {
      await aenc.flush()
    } catch (e) {}
    try {
      aenc.close()
    } catch (e) {}
    return { chunks, sampleRate: ab.sampleRate, channels: nch, pcmFrames: frames, error: null }
  } catch (e) {
    return { ...empty, error: '音频解码/编码失败：' + (e && e.message) }
  }
}
