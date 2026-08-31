# 录屏产物结构诊断：解 mp4/mov box，看有几条轨、各轨样本数与时长。
# 用法：python mp4probe.py <file.mp4> [...]
# 为啥要解 box：MediaRecorder/WebCodecs 都可能写出「moov 里有 soun 骨架但 sample_count=0」的
# 空音轨，字符串匹配 /mp4a/ 会误报成「有音轨」。只有 stsz 的 sample_count 才是真的。
import sys, struct, os


def walk(buf, start, end, depth, out):
    i = start
    while i + 8 <= end:
        size = struct.unpack(">I", buf[i:i + 4])[0]
        typ = buf[i + 4:i + 8].decode("latin1")
        hdr = 8
        if size == 1:
            size = struct.unpack(">Q", buf[i + 8:i + 16])[0]
            hdr = 16
        elif size == 0:
            size = end - i
        if size < hdr or i + size > end:
            break
        body = i + hdr
        out.append((depth, typ, size, body, i))
        if typ in ("moov", "trak", "mdia", "minf", "stbl", "dinf", "edts", "mvex", "moof", "traf"):
            walk(buf, body, i + size, depth + 1, out)
        i += size


def probe(path):
    print("=" * 64)
    print("FILE: %s  (%d bytes)" % (os.path.basename(path), os.path.getsize(path)))
    buf = open(path, "rb").read()
    boxes = []
    walk(buf, 0, len(buf), 0, boxes)
    print("  top-level:", [t for d, t, sz, body, off in boxes if d == 0])

    for d, t, sz, body, off in boxes:
        if t == "mvhd":
            ver = buf[body]
            if ver == 1:
                ts = struct.unpack(">I", buf[body + 20:body + 24])[0]
                du = struct.unpack(">Q", buf[body + 24:body + 32])[0]
            else:
                ts = struct.unpack(">I", buf[body + 12:body + 16])[0]
                du = struct.unpack(">I", buf[body + 16:body + 20])[0]
            print("  mvhd: timescale=%d duration=%d -> %.2fs" % (ts, du, du / ts if ts else 0))

    traks = [b for b in boxes if b[1] == "trak"]
    for idx, (d, t, sz, body, off) in enumerate(traks):
        sub = []
        walk(buf, body, off + sz, 0, sub)
        hdlr = stsd = None
        stsz = None
        mdhd_ts = mdhd_du = 0
        for dd, tt, ss, bb, oo in sub:
            if tt == "hdlr":
                hdlr = buf[bb + 12:bb + 16].decode("latin1")
            elif tt == "stsz":
                sample_size = struct.unpack(">I", buf[bb + 4:bb + 8])[0]
                cnt = struct.unpack(">I", buf[bb + 8:bb + 12])[0]
                stsz = (sample_size, cnt)
            elif tt == "stsd":
                stsd = buf[bb + 12:bb + 16].decode("latin1")
            elif tt == "mdhd":
                ver = buf[bb]
                if ver == 1:
                    mdhd_ts = struct.unpack(">I", buf[bb + 20:bb + 24])[0]
                    mdhd_du = struct.unpack(">Q", buf[bb + 24:bb + 32])[0]
                else:
                    mdhd_ts = struct.unpack(">I", buf[bb + 12:bb + 16])[0]
                    mdhd_du = struct.unpack(">I", buf[bb + 16:bb + 20])[0]
        dur = (mdhd_du / mdhd_ts) if mdhd_ts else 0
        stsz_txt = ("sample_size=%d count=%d" % stsz) if stsz else "no stsz"
        print("  trak[%d] handler=%s codec=%s duration=%.2fs stsz(%s)" % (idx, hdlr, stsd, dur, stsz_txt))


for p in sys.argv[1:]:
    probe(p)
