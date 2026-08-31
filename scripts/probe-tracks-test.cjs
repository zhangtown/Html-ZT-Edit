// 用真实产物验证 App.jsx 里 probeTracks 的解析逻辑（不依赖浏览器）。
// 用法：node scripts/probe-tracks-test.cjs <file.mp4> [...]
// 目的：这个解析器曾经因为「只扫 trak 的直接子 box」漏掉 hdlr/stsz（它们分别在
// trak/mdia 和 trak/mdia/minf/stbl 下），把「视频轨正常」误报成「产物含视频轨:否」。
// 改完逻辑必须拿真实产物回归一次。
const fs = require('fs')

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'udta'])

function probeTracks(path) {
  const fd = fs.openSync(path, 'r')
  const size = Math.min(512 * 1024, fs.statSync(path).size)
  const buf = Buffer.alloc(size)
  fs.readSync(fd, buf, 0, size, 0)
  fs.closeSync(fd)

  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const u32 = (i) => dv.getUint32(i)
  const tagAt = (i) => String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3])

  const walkRange = (start, end, onBox, deep) => {
    let i = start
    while (i + 8 <= end) {
      let sz = u32(i)
      let hdr = 8
      if (sz === 1) {
        if (i + 16 > end) return
        sz = Number(dv.getBigUint64(i + 8))
        hdr = 16
      } else if (sz === 0) {
        sz = end - i
      }
      if (sz < hdr || i + sz > end) return
      const type = tagAt(i + 4)
      const body = i + hdr
      const boxEnd = i + sz
      onBox(type, body, boxEnd, i)
      if (deep && CONTAINERS.has(type)) walkRange(body, boxEnd, onBox, true)
      i += sz
    }
  }

  const res = { video: 0, soun: 0, videoSamples: 0, audioSamples: 0, traks: [] }
  let moovStart = -1
  let moovEnd = -1
  walkRange(0, u8.length, (type, body, boxEnd) => {
    if (type === 'moov' && moovStart < 0) {
      moovStart = body
      moovEnd = boxEnd
    }
  })
  if (moovStart < 0) return res
  walkRange(moovStart, moovEnd, (type, body, boxEnd) => {
    if (type !== 'trak') return
    let handler = null
    let count = 0
    let codec = null
    walkRange(
      body,
      boxEnd,
      (t2, b2, e2) => {
        if (t2 === 'hdlr' && b2 + 12 <= e2) {
          handler = String.fromCharCode(u8[b2 + 8], u8[b2 + 9], u8[b2 + 10], u8[b2 + 11])
        } else if (t2 === 'stsz' && b2 + 12 <= e2) {
          count = u32(b2 + 8)
        } else if (t2 === 'stsd' && b2 + 16 <= e2) {
          // stsd: version/flags(4) + entry_count(4) + entry(size 4 + format 4 ...)
          // 所以第一个 entry 的 format 在 body+12
          codec = String.fromCharCode(u8[b2 + 12], u8[b2 + 13], u8[b2 + 14], u8[b2 + 15])
        }
      },
      true
    )
    res.traks.push({ handler, codec, count })
    if (handler === 'vide') {
      res.video += 1
      res.videoSamples += count
    } else if (handler === 'soun') {
      res.soun += 1
      res.audioSamples += count
    }
  })
  return res
}

let fail = 0
for (const p of process.argv.slice(2)) {
  const r = probeTracks(p)
  const name = p.split(/[\\/]/).pop()
  console.log(`\n${name}`)
  for (const t of r.traks) {
    console.log(`  handler=${t.handler} codec=${t.codec} samples=${t.count}`)
  }
  console.log(
    `  => video=${r.video}(${r.videoSamples}样本) soun=${r.soun}(${r.audioSamples}样本)` +
      `  「含音轨」判据=${r.soun > 0 && r.audioSamples > 0}`
  )
  // 健全性检查：能解 moov 的产物至少得有一条 trak
  if (r.traks.length === 0) {
    console.log('  !! 一条 trak 都没解析出来 —— 解析器有问题')
    fail++
  }
}
process.exit(fail ? 1 : 0)
