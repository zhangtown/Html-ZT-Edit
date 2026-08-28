#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vo-pipeline 阶段1引擎：edge-tts 合成口播 MP3 + 精确 SRT
零系统依赖（uv 按需拉取 edge-tts / mutagen / imageio-ffmpeg），无需 GPU。
SRT 时间轴来自 edge-tts WordBoundary 事件（微软服务端字级时间戳），
并将字级事件对齐回原文以保留标点、按标点自然断条。

用法（在 vo-pipeline/ 目录下运行）:
  uv run --with edge-tts --with mutagen --with imageio-ffmpeg python scripts/tts_edge.py 文案.txt \
      --voice zh-CN-XiaoxiaoNeural "--rate=-4%" --out-dir 输出目录 --name 口播

试听选音色:
  ... python scripts/tts_edge.py 文案.txt --audition "大家好，欢迎来到本期节目。"
"""
import argparse
import asyncio
import bisect
import json
import pathlib
import re
import shutil
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

STRONG = set("。！？!?；;…")
SOFT = set("，、：:,—–-")
PUNCT = STRONG | SOFT | set("。．？！!?；;…，、：:—–-．.,\"“”‘’'（）()《》〈〉[]【】{}<> \t\u3000")
DEFAULT_VOICES = ",".join([
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-XiaoyiNeural",
    "zh-CN-YunxiNeural",
    "zh-CN-YunyangNeural",
    "zh-CN-YunjianNeural",
    "zh-CN-YunxiaNeural",
    "zh-CN-liaoning-XiaobeiNeural",
    "zh-CN-shaanxi-XiaoniNeural",
])


def parse_args():
    p = argparse.ArgumentParser(description="edge-tts 口播合成：文案 → MP3 + SRT")
    p.add_argument("text_file", help="口播文案 txt（空行分段）")
    p.add_argument("--voice", default="zh-CN-XiaoxiaoNeural")
    p.add_argument("--rate", default="-4%", help='语速，如 "-4%%" / "+8%%"（传参建议用 --rate=-4%% 等号形式）')
    p.add_argument("--pitch", default="+0Hz")
    p.add_argument("--volume", default="+0%")
    p.add_argument("--out-dir", default=".")
    p.add_argument("--name", default="口播", help="输出文件名前缀：{name}.mp3 / {name}.srt")
    p.add_argument("--gap", type=float, default=0.35, help="段落间静音秒数（自动检测 ffmpeg，无则自然停顿）")
    p.add_argument("--no-loudnorm", action="store_true", help="跳过响度归一（默认 -16 LUFS）")
    p.add_argument("--max-chars", type=int, default=20, help="单条字幕最大字符数")
    p.add_argument("--apply-table", default="", help="替换表 txt（每行 误=正，用于多音字/读法修正）")
    p.add_argument("--audition", default="", help="传入一句文本，对候选音色各合成一条试听")
    p.add_argument("--audition-voices", default=DEFAULT_VOICES)
    return p


def norm_rate(r):
    r = r.strip().replace("－", "-").replace("＋", "+")
    if not re.match(r"^[+-]", r):
        r = "+" + r
    if not r.endswith("%"):
        r += "%"
    return r


def load_table(path):
    tab = {}
    if path and pathlib.Path(path).exists():
        for line in pathlib.Path(path).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if "=" in line:
                a, b = line.split("=", 1)
                if a.strip() and b.strip():
                    tab[a.strip()] = b.strip()
    return tab


def split_paragraphs(text):
    paras = [re.sub(r"[ \t\u3000]+", " ", x).strip() for x in re.split(r"\n\s*\n", text)]
    return [x for x in paras if x]


# ---------- 字幕断条 ----------

def _split_span(text, x, y, max_chars, out):
    """把原文 [x,y) 切成 ≤max_chars+2 的段：优先在段内靠后的软标点处断开。"""
    if y - x <= max_chars + 2:
        out.append((x, y))
        return
    cut = None
    for k in range(min(x + max_chars, y - 1), x + 3, -1):
        if text[k] in SOFT:
            cut = k + 1
            break
    if cut is None:
        for k in range(x + 4, y - 3):
            if text[k] in SOFT:
                cut = k + 1
                break
    if cut is None or cut <= x + 2 or cut >= y - 1:
        cut = x + (y - x) // 2
    _split_span(text, x, cut, max_chars, out)
    _split_span(text, cut, y, max_chars, out)


def split_spans(text, max_chars):
    """原文 → [(start,end)]：先按强标点断句，超长句再按软标点二次切分。"""
    spans, seg = [], 0
    for j, ch in enumerate(text):
        if ch in STRONG:
            spans.append((seg, j + 1))
            seg = j + 1
    if seg < len(text):
        spans.append((seg, len(text)))
    out = []
    for a, b in spans:
        if text[a:b].strip():
            _split_span(text, a, b, max_chars, out)
    return out


def align_words(text, words):
    """把字级事件对齐回原文。返回 (events, pref)；
    events: [(clean_start, clean_end, t0, t1)]；pref[i] = text[:i] 中非标点字符数。
    对不齐返回 (None, pref)。"""
    pref = [0] * (len(text) + 1)
    for i, c in enumerate(text):
        pref[i + 1] = pref[i] + (0 if c in PUNCT else 1)
    orig_clean = [c.lower() for c in text if c not in PUNCT]
    evs, ci = [], 0
    for w in words:
        wt = "".join(c for c in w["text"] if c not in PUNCT).lower()
        if not wt:
            continue
        if orig_clean[ci:ci + len(wt)] != list(wt):
            return None, pref
        evs.append((ci, ci + len(wt), w["offset"], w["offset"] + w["dur"]))
        ci += len(wt)
    if not evs or ci != len(orig_clean):
        return None, pref
    return evs, pref


def _t_of(evs, k, end):
    """第 k 个非标点字符的时间（end=True 取终点）；落在标点间隙时取邻近事件边界。"""
    i = bisect.bisect_right(evs, (k, float("inf"), float("inf"), float("inf"))) - 1
    if i < 0:
        return evs[0][2] if evs else 0.0
    cs, ce, t0, t1 = evs[i]
    if k < ce:
        frac = (k - cs + (1 if end else 0)) / max(1, ce - cs)
        return t0 + (t1 - t0) * min(1.0, max(0.0, frac))
    if i + 1 < len(evs):
        return evs[i + 1][2] if not end else t1
    return t1


def build_cues(text, words, max_chars, para_start, para_dur):
    """段落原文 + 字级事件 → 字幕条（保留标点、按标点断条）。
    words 为空或对不齐时，退化为按字符数线性分配时间。"""
    spans = split_spans(text, max_chars)
    evs, pref = align_words(text, words)
    cues = []
    if evs:
        for a, b in spans:
            cues.append({
                "start": para_start + _t_of(evs, pref[a], end=False),
                "end": para_start + _t_of(evs, pref[b] - 1, end=True),
                "text": text[a:b],
            })
    else:
        total_chars = max(1, len(text.replace(" ", "")))
        t0 = para_start
        for a, b in spans:
            frac = len(text[a:b].replace(" ", "")) / total_chars
            d = para_dur * frac
            cues.append({"start": t0, "end": t0 + d, "text": text[a:b]})
            t0 += d
    return cues


# ---------- 输出 ----------

def fmt_srt(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def srt_block(cues):
    out = []
    for i, c in enumerate(cues, 1):
        out.append(f"{i}\n{fmt_srt(max(0, c['start']))} --> {fmt_srt(c['end'])}\n{c['text']}\n")
    return "\n".join(out)


def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def mp3_duration(data):
    from io import BytesIO
    from mutagen.mp3 import MP3
    try:
        return MP3(BytesIO(data)).info.length
    except Exception:
        return None


# ---------- 合成 ----------

async def synth(text, args):
    import edge_tts
    com = edge_tts.Communicate(text, args.voice, rate=norm_rate(args.rate),
                               pitch=args.pitch, volume=args.volume,
                               boundary="WordBoundary")
    audio, words = bytearray(), []
    async for ch in com.stream():
        if ch["type"] == "audio":
            audio.extend(ch["data"])
        elif ch["type"] == "WordBoundary":
            words.append({"offset": ch["offset"] / 1e7,
                          "dur": ch["duration"] / 1e7,
                          "text": ch["text"]})
    return bytes(audio), words


async def synth_retry(text, args, tries=3):
    last = None
    for k in range(tries):
        try:
            return await synth(text, args)
        except Exception as e:
            last = e
            await asyncio.sleep(1.5 * (k + 1))
    raise SystemExit(f"[失败] 段落合成异常（网络/服务不可达？）: {last}")


def silence_mp3(ffmpeg, seconds):
    if not ffmpeg or seconds <= 0:
        return b""
    r = subprocess.run(
        [ffmpeg, "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
         "-t", str(seconds), "-b:a", "48k", "-f", "mp3", "-"],
        capture_output=True)
    return r.stdout or b""


async def audition(args, out_dir):
    vdir = out_dir / "试听"
    vdir.mkdir(parents=True, exist_ok=True)
    print(f"试听文本: {args.audition}")
    for v in [x.strip() for x in args.audition_voices.split(",") if x.strip()]:
        try:
            audio, _ = await synth_retry(args.audition, argparse.Namespace(**{**vars(args), "voice": v}))
            (vdir / f"{v}.mp3").write_bytes(audio)
            print(f"  [ok] {v}")
        except SystemExit as e:
            print(f"  [失败] {v}: {e}")


async def main():
    args = parse_args().parse_args()
    out_dir = pathlib.Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.audition:
        await audition(args, out_dir)
        print(f"试听包已生成: {out_dir / '试听'}（挨个听，选定后把音色名写进配置）")
        return

    text = pathlib.Path(args.text_file).read_text(encoding="utf-8")
    for a, b in load_table(args.apply_table).items():
        text = text.replace(a, b)
    paras = split_paragraphs(text)
    if not paras:
        raise SystemExit("[失败] 文案为空")

    ffmpeg = find_ffmpeg()
    gap_bytes = silence_mp3(ffmpeg, args.gap) if args.gap > 0 else b""

    mp3s, cues_all, cursor = [], [], 0.0
    for i, ptxt in enumerate(paras):
        print(f"合成段落 {i + 1}/{len(paras)}（{len(ptxt)} 字）…")
        audio, words = await synth_retry(ptxt, args)
        if not audio:
            raise SystemExit(f"[失败] 第 {i + 1} 段无音频返回")

        # 段落精确时长：mutagen 优先，兜底用最后词尾
        pdur = mp3_duration(audio)
        if pdur is None and words:
            pdur = words[-1]["offset"] + words[-1]["dur"]
        pdur = pdur or 0.0

        # words 偏移保持段落本地坐标，全局平移由 build_cues 内的 para_start 统一处理
        cues_all.extend(build_cues(ptxt, words, args.max_chars, cursor, pdur))

        mp3s.append(audio)
        cursor += pdur
        if gap_bytes and i < len(paras) - 1:
            mp3s.append(gap_bytes)
            cursor += args.gap

    raw = out_dir / f"{args.name}.raw.mp3"
    raw.write_bytes(b"".join(mp3s))

    final = out_dir / f"{args.name}.mp3"
    if ffmpeg and not args.no_loudnorm:
        print("响度归一（-16 LUFS）…")
        r = subprocess.run([ffmpeg, "-v", "error", "-y", "-i", str(raw),
                            "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
                            "-ar", "24000", "-b:a", "64k", str(final)],
                           capture_output=True)
        if r.returncode == 0 and final.exists():
            raw.unlink()
        else:
            raw.rename(final)
            print("[提示] loudnorm 失败，保留未归一音频:", r.stderr.decode(errors="ignore")[:200])
    else:
        raw.rename(final)
        if not args.no_loudnorm:
            print("[提示] 未找到 ffmpeg（--with imageio-ffmpeg），跳过响度归一")

    (out_dir / f"{args.name}.srt").write_text(srt_block(cues_all), encoding="utf-8")
    meta = {
        "engine": "edge-tts",
        "voice": args.voice,
        "rate": norm_rate(args.rate),
        "pitch": args.pitch,
        "volume": args.volume,
        "paragraph_gap_sec": args.gap,
        "loudnorm": bool(ffmpeg) and not args.no_loudnorm,
        "paragraphs": len(paras),
        "duration_sec": round(cursor, 2),
        "srt_cues": len(cues_all),
    }
    (out_dir / f"{args.name}.voice.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    n_chars = sum(len(p) for p in paras)
    speed = n_chars / cursor if cursor else 0
    print(f"[完成] {final}")
    print(f"       {final.with_suffix('.srt')}（{len(cues_all)} 条）")
    print(f"       时长 {cursor:.1f}s / {n_chars} 字 ≈ {speed:.1f} 字/秒"
          f"{'（偏快，检查是否吞句）' if speed > 6.5 else ''}")


if __name__ == "__main__":
    asyncio.run(main())
