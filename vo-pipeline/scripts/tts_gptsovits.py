#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vo-pipeline 阶段2引擎：GPT-SoVITS 本地音色克隆合成
前提：本机已启动 GPT-SoVITS 的 api_v2 服务（默认 http://127.0.0.1:9880），
     并在服务端或本脚本参数中指定参考音频（你的音色样本）。

原理：逐句调用 /tts 接口 → 每句 WAV 时长精确可测 → 拼接 → SRT 由句时长直接生成（无需 ASR）
     → 最终 ffmpeg 转 MP3 + 响度归一（无 ffmpeg 则保留 WAV）。

用法:
  uv run --with imageio-ffmpeg python scripts/tts_gptsovits.py 文案.txt \
      --ref-audio 我的音色样本.wav --prompt-text "参考音频里说的那句话" \
      --out-dir 输出目录 --name 口播 --speed 1.0
"""
import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.request
import wave

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def parse_args():
    p = argparse.ArgumentParser(description="GPT-SoVITS 口播合成：文案 → MP3/WAV + SRT")
    p.add_argument("text_file")
    p.add_argument("--api", default="http://127.0.0.1:9880")
    p.add_argument("--ref-audio", required=True, help="音色参考音频（3~10s 干净人声 wav）")
    p.add_argument("--prompt-text", required=True, help="参考音频里说的那句话（一字不差）")
    p.add_argument("--prompt-lang", default="zh")
    p.add_argument("--text-lang", default="zh")
    p.add_argument("--speed", type=float, default=1.0, help="语速因子 1.0=原速")
    p.add_argument("--out-dir", default=".")
    p.add_argument("--name", default="口播")
    p.add_argument("--gap", type=float, default=0.30, help="句子间停顿秒数")
    p.add_argument("--no-loudnorm", action="store_true")
    return p


def split_sentences(text, max_len=60):
    """按句末标点切句；超长句在逗号处二次切分，保证单句适合 TTS。"""
    parts = re.findall(r"[^。！？；!?;…\n]+[。！？；!?;…]?|\n", text)
    sents = [p.strip() for p in parts if p.strip() and p.strip() != "\n"]
    out = []
    for s in sents:
        while len(s) > max_len:
            cut = 0
            for k in range(max_len, 10, -1):
                if s[k - 1] in "，、：:,":
                    cut = k
                    break
            if cut == 0:
                cut = max_len
            out.append(s[:cut].strip())
            s = s[cut:]
        if s:
            out.append(s)
    return out


def tts_call(api, payload, out_wav):
    req = urllib.request.Request(
        api.rstrip("/") + "/tts",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r, open(out_wav, "wb") as f:
        f.write(r.read())


def wav_params(path):
    with wave.open(str(path), "rb") as w:
        return w.getparams()


def wav_frames(path):
    with wave.open(str(path), "rb") as w:
        return w.readframes(w.getnframes())


def silence_wav(params, seconds):
    sr, nch, sw = params.framerate, params.nchannels, params.sampwidth
    n = int(sr * seconds) * nch * sw
    return b"\x00" * n


def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def main():
    args = parse_args().parse_args()
    out_dir = pathlib.Path(args.out_dir)
    tmp = out_dir / "_pieces"
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp.mkdir(exist_ok=True)

    text = pathlib.Path(args.text_file).read_text(encoding="utf-8")
    sents = split_sentences(text)
    if not sents:
        raise SystemExit("[失败] 文案为空")

    payload_base = {
        "text_lang": args.text_lang,
        "ref_audio_path": str(pathlib.Path(args.ref_audio).resolve()),
        "prompt_text": args.prompt_text,
        "prompt_lang": args.prompt_lang,
        "speed_factor": args.speed,
        "text_split_method": "cut0",
    }

    pieces, cues, cursor = [], [], 0.0
    params = None
    for i, s in enumerate(sents):
        print(f"合成 {i + 1}/{len(sents)}: {s[:24]}…")
        piece = tmp / f"{i:04d}.wav"
        try:
            tts_call(args.api, {**payload_base, "text": s}, piece)
        except Exception as e:
            raise SystemExit(f"[失败] 第 {i + 1} 句调用 api_v2 失败（服务没启动？）: {e}")
        if params is None:
            params = wav_params(piece)
        dur = wav_params(piece).nframes / params.framerate
        cues.append({"start": cursor, "end": cursor + dur, "text": s})
        pieces.append(piece)
        cursor += dur
        if args.gap > 0 and i < len(sents) - 1:
            cues.append({"start": cursor, "end": cursor + args.gap, "text": "（间隙，不导出）"})
            cursor += args.gap

    cues = [c for c in cues if c["text"] != "（间隙，不导出）"]

    raw_wav = out_dir / f"{args.name}.raw.wav"
    with wave.open(str(raw_wav), "wb") as w:
        w.setparams(params)
        for i, piece in enumerate(pieces):
            w.writeframes(wav_frames(piece))
            if args.gap > 0 and i < len(pieces) - 1:
                w.writeframes(silence_wav(params, args.gap))

    fmt = lambda t: (f"{int(t // 3600):02d}:{int(t % 3600 // 60):02d}:"
                     f"{int(t % 60):02d},{int(t % 1 * 1000):03d}")
    srt = "\n".join(f"{i}\n{fmt(c['start'])} --> {fmt(c['end'])}\n{c['text']}\n"
                    for i, c in enumerate(cues, 1))
    (out_dir / f"{args.name}.srt").write_text(srt, encoding="utf-8")

    ffmpeg = find_ffmpeg()
    final = out_dir / f"{args.name}.mp3"
    if ffmpeg and not args.no_loudnorm:
        subprocess.run([ffmpeg, "-v", "error", "-y", "-i", str(raw_wav),
                        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-b:a", "96k", str(final)],
                       capture_output=True)
    if not final.exists():
        final = raw_wav
        print("[提示] ffmpeg 不可用，保留 WAV 输出")
    else:
        raw_wav.unlink()

    (out_dir / f"{args.name}.voice.json").write_text(json.dumps({
        "engine": "gptsovits", "api": args.api,
        "ref_audio": args.ref_audio, "speed_factor": args.speed,
        "sentences": len(sents), "duration_sec": round(cursor, 2),
        "srt_cues": len(cues),
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    shutil.rmtree(tmp, ignore_errors=True)
    n_chars = sum(len(s) for s in sents)
    print(f"[完成] {final}")
    print(f"       {out_dir / (args.name + '.srt')}（{len(cues)} 条）")
    print(f"       时长 {cursor:.1f}s / {n_chars} 字 ≈ {n_chars / cursor if cursor else 0:.1f} 字/秒")


if __name__ == "__main__":
    main()
