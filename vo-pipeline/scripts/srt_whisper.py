#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vo-pipeline 配套工具：任意音频 → SRT（faster-whisper ASR 对齐）
用途：外部音频补时间轴、TTS 成片抽查。

用法:
  uv run --with faster-whisper python scripts/srt_whisper.py 音频.mp3 --model small --out 口播.srt
显存参考（1660S 6GB）：small int8 ≈1GB、medium int8 ≈2.5GB，均可跑；无 N 卡自动退 CPU（慢）。
"""
import argparse
import pathlib
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def fmt(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("audio")
    p.add_argument("--model", default="small", help="tiny/base/small/medium/large-v3")
    p.add_argument("--language", default="zh")
    p.add_argument("--out", default="")
    p.add_argument("--max-chars", type=int, default=20, help="单条字幕最大字符数")
    args = p.parse_args()

    from faster_whisper import WhisperModel
    print(f"加载模型 {args.model} …")
    model = WhisperModel(args.model, device="auto", compute_type="auto")
    print("转写对齐中…")
    segments, info = model.transcribe(args.audio, language=args.language,
                                      vad_filter=True, word_timestamps=False)

    cues = []
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        dur = seg.end - seg.start
        n = max(1, round(len(text) / args.max_chars))
        step = dur / n
        for k in range(n):
            piece = text[k * args.max_chars:(k + 1) * args.max_chars]
            if piece:
                cues.append((seg.start + k * step, seg.start + (k + 1) * step, piece))

    out = pathlib.Path(args.out) if args.out else pathlib.Path(args.audio).with_suffix(".srt")
    out.write_text("\n".join(f"{i}\n{fmt(a)} --> {fmt(b)}\n{t}\n"
                             for i, (a, b, t) in enumerate(cues, 1)), encoding="utf-8")
    print(f"[完成] {out}（{len(cues)} 条，音频 {info.duration:.1f}s）")


if __name__ == "__main__":
    main()
