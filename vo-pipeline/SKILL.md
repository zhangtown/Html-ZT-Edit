---
name: vo-pipeline
description: 口播产线：定稿文案一键合成 MP3 + 精确 SRT。默认 edge-tts 引擎（免费、字级时间轴、零依赖），支持 GPT-SoVITS 本地音色克隆（6GB 显存可跑）、语速/音色参数化、响度归一去AI味、试听选音色。产出可直接喂给 speech-visual-html 技能生成视觉页。
triggers:
  - "口播"
  - "配音"
  - "TTS"
  - "语音合成"
  - "音色"
  - "克隆音色"
  - "朗读"
  - "SRT"
  - "去AI味"
version: 1.0
defaultEngine: edge-tts
---

# vo-pipeline 口播产线 v1.0

> 输入一段**定稿口播文案**，产出 `XX.MP3 + XX.srt`（+ 合成参数存档 `XX.voice.json`），
> 命名对齐 speech-visual-html 技能的输入约定，可直接进入视觉页生成。
> 所有脚本零系统依赖：uv 按需拉取 `edge-tts` / `mutagen` / `imageio-ffmpeg` / `faster-whisper`。

## 输入 / 输出

| 项 | 说明 |
| --- | --- |
| 输入 | 定稿口播文案 `XX.txt`（**空行分段**，段内换行会被合并；建议每段 3~6 句） |
| 可选输入 | 替换表 `XX-替换表.txt`（每行 `误=正`，修多音字/数字读法，如 `长=cháng读作…`用同音字替换法） |
| 输出 | `XX.mp3`（响度 -16 LUFS）、`XX.srt`、`XX.voice.json`（参数存档，复用/追溯） |

## 工作流（Agent 按此执行）

### Phase 0 · 文案口语化打磨（去AI味第一关）

拿到定稿文案后，先做**轻度**口语化处理（除非用户声明"不要改动文案"）：
- 长句拆短：书面长句拆成 ≤25 字的短句，TTS 断句自然
- 停顿标注：需要明显停顿处用破折号"——"或省略号"…"
- 书面语→口语：如"然而"→"但是"、"因此"→"所以"、"即"→"也就是"
- 多音字/生僻读法：写进 `XX-替换表.txt`（用同音字替换法，edge-tts 按"字"读）
- 数字读法有歧义时手动改写：如"1980年代"→"上世纪八十年代"
- 向用户展示改动摘要（改了哪几处、为什么），**不改变原意**

### Phase 1 · 选音色（首次或用户要求时）

```bash
cd vo-pipeline
uv run --with edge-tts --with mutagen python scripts/tts_edge.py 文案.txt \
    --audition "大家好，欢迎来到本期节目。今天我们聊一个有意思的话题。"
```
产出 `试听/*.mp3`，请用户试听选择。常用音色见 [voices.md](voices.md)。
选定后写入工程目录 `vo.config.json`（参考 `config.example.json`），下次直接用。

### Phase 2 · 合成（默认引擎 edge-tts）

```bash
uv run --with edge-tts --with mutagen --with imageio-ffmpeg python scripts/tts_edge.py 文案.txt \
    --voice zh-CN-XiaoxiaoNeural "--rate=-4%" \
    --apply-table "XX-替换表.txt" --out-dir <工程目录> --name XX
```
- `--rate` 建议区间 `-8% ~ +5%`；**注意负值参数必须用 `--rate=-4%` 等号形式**（否则被 argparse 当选项）
- SRT 由微软服务端字级时间戳直接生成（无需 ASR），中文默认按 ≤20 字/条断条
- 段落间默认插 0.35s 静音（`--gap` 调整）

### Phase 2' · 音色克隆引擎（GPT-SoVITS，学习"我的音色"）

前提：本机已部署并启动 GPT-SoVITS api_v2（部署指南见下节），准备 3~10s 干净音色样本 wav。

```bash
uv run --with imageio-ffmpeg python scripts/tts_gptsovits.py 文案.txt \
    --ref-audio 我的音色样本.wav --prompt-text "样本里说的那句话原文" \
    "--speed=1.0" --out-dir <工程目录> --name XX
```
- 逐句合成，SRT 由每句精确时长直接生成，同样无需 ASR
- 语速用 `--speed`（0.8~1.2）；合成质量不满意优先换/换位置裁剪参考音频，其次调 speed

**GPT-SoVITS 部署（1660S 6GB 实测可行）**：
1. 下载官方 Windows 整合包（GitHub Releases，国内走 `ghproxy` 类镜像加速），解压即用
2. go-webui.bat 打开训练界面：3~10s 参考音频可**零样本克隆**直接推理；
   想更像 → 用 1~5 分钟干净录音走微调（SoVITS + GPT 各几百步，6GB 显存 batch=1 可训，约十几分钟）
3. 启动推理 API：`runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml`
   （webui 里"开启推理服务"按钮等价）
4. 模型下载走 `hf-mirror.com`（`set HF_ENDPOINT=https://hf-mirror.com`）
5. 显存参考：推理 ≈4GB；别同时开游戏/浏览器大页面

### Phase 3 · 质检

1. **语速体检**（脚本已自动报告"字/秒"）：中文口播舒适区 **4.0~5.5 字/秒**，>6.5 字/秒说明吞字或文案过长
2. **SRT 抽查**：打开 srt 看首尾条时间与文案段落对应关系；怀疑不准时用 ASR 交叉验证：
   ```bash
   uv run --with faster-whisper python scripts/srt_whisper.py XX.mp3 --model small --out XX-校验.srt
   ```
   两版时间轴偏差应 <0.5s
3. **听感抽查**：首、中、尾各听一段；数字/多音字处重点听
4. 响度已归一到 -16 LUFS（短视频平台常用）；如需更响改脚本里 `I=-16`

### Phase 4 · 交接 speech-visual-html

把工程目录整理成生成技能的输入约定：
- `XX.MP3`（注意 .MP3 扩展名大小写与样例一致更稳）
- `XX.srt` 或 `XX- 字幕+时间轴.txt`
- `素材1.png`、`素材2.png`…
然后调用 speech-visual-html 技能生成视觉页。

## 去AI味清单（按收益排序）

1. **文案层**（收益最大）：Phase 0 的口语化打磨——TTS 的"AI味"一半来自书面语
2. **语速**：`-4%` 附近比默认更沉稳；整篇匀速偏机械，重要句可单独合成再拼
3. **停顿**：段落间 0.3~0.5s 真静音，比标点自然停顿更接近真人换气
4. **响度归一**：-16 LUFS 统一响度，避免忽大忽小的"合成感"
5. **克隆**：GPT-SoVITS 用本人 1~5 分钟录音微调后，相似度和自然度远超通用音色
6. 终极手段：合成后 DAW/ffmpeg 做极轻微底噪与房间感（如 `aecho=0.8:0.9:40|60:0.15|0.1`，慎用）

## 输出命名与目录约定

```
<工程目录>/
├── XX.txt               # 定稿文案（空行分段）
├── XX-替换表.txt         # 可选
├── vo.config.json       # 音色/参数配置（复用）
├── XX.mp3  XX.srt  XX.voice.json
├── 试听/                 # Phase 1 产物
└── （接着放 素材1.png… → 交给 speech-visual-html）
```

## 引擎对比与选择

| | edge-tts（默认） | GPT-SoVITS（克隆） |
| --- | --- | --- |
| 成本/依赖 | 免费，uv 在线拉包即可 | 整合包 ~几GB + N 卡（6GB 可跑） |
| 音色 | 微软官方音色库（见 voices.md） | 你的音色（3~10s 零样本 / 1~5min 微调） |
| SRT 来源 | 服务端字级时间戳 | 逐句合成时长（精确） |
| 去AI味上限 | 中（参数+文案层） | 高（本人音色） |
| 适用 | 快速出片、批量 | 正式成品、个人 IP 声音 |

## 常见问题

- **合成报网络错误**：edge-tts 走微软服务，检查代理；脚本已内置 3 次重试
- **多音字读错**：替换表用同音字硬替换（如"重庆"读错→表里写 `重= chóng`行不通，直接写成同音字"崇庆"再听校对）
- **某句总是怪**：拆成两句，或该句单独用另一个 rate 合成后手工拼接
- **SRT 想要纯句子级**：把 `--max-chars` 调大（如 40）即可少断条
