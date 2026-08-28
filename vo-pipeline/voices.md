# 音色库速查（edge-tts 中文）

> 完整列表：`uvx edge-tts --list-voices | findstr zh-CN`
> 试听命令见 SKILL.md Phase 1。以下按用途推荐。

## 女声

| 音色 | 特点 | 适用 |
| --- | --- | --- |
| `zh-CN-XiaoxiaoNeural` | 全能甜暖，情感最丰富，支持多语言 | 默认首选、讲解、带货 |
| `zh-CN-XiaoyiNeural` | 活泼年轻，语速偏快 | 轻松话题、快节奏 |
| `zh-CN-liaoning-XiaobeiNeural` | 东北口音 | 逗趣、接地气内容 |
| `zh-CN-shaanxi-XiaoniNeural` | 陕西口音 | 方言梗 |

## 男声

| 音色 | 特点 | 适用 |
| --- | --- | --- |
| `zh-CN-YunxiNeural` | 阳光年轻，叙事感好 | 默认男声首选、科普解说 |
| `zh-CN-YunyangNeural` | 新闻播音腔，正式 | 时政、严肃复盘 |
| `zh-CN-YunjianNeural` | 成熟磁性， Sports/纪录片感 | 历史复盘、深度内容 |
| `zh-CN-YunxiaNeural` | 少年音 | 轻科普 |

## 经验

- 讲故事/复盘类（如"唐朝不存在"项目）：`YunjianNeural`（男）或 `XiaoxiaoNeural`（女）
- 试听对比如有明显"翻译腔"，多半是文案问题（见 SKILL.md Phase 0）
- 语速偏慢的音色配 `--rate=+4%`，偏快的配 `"--rate=-4%"`
