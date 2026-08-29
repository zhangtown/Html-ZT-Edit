// 校验 ztEdit 原生格式契约在两仓的版本一致性：
//   正本：本仓库 WORKFLOW.md「二、数据模型」（当前契约版本 vX.Y）
//   实现方：my-skills 仓库 speech-visual-html/SKILL.md（ztEdit 原生格式规范（vX.Y）
// 技能库默认取 ~/.agents/skills（三端 junction 共享主库），可用 --skill-path 覆盖。
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const skillPathIdx = args.indexOf('--skill-path');
const skillMd =
  skillPathIdx >= 0
    ? path.resolve(args[skillPathIdx + 1], 'SKILL.md')
    : path.join(os.homedir(), '.agents', 'skills', 'speech-visual-html', 'SKILL.md');

const workflow = fs.readFileSync(path.join(repoRoot, 'WORKFLOW.md'), 'utf8');
const m1 = workflow.match(/当前契约版本 v([\d.]+)/);
if (!m1) {
  console.error('[contract-check] 正本未找到：WORKFLOW.md 缺少「当前契约版本 vX.Y」声明');
  process.exit(1);
}

let skill;
try {
  skill = fs.readFileSync(skillMd, 'utf8');
} catch {
  console.error(`[contract-check] 技能文档不存在：${skillMd}`);
  console.error('  请先 git clone https://github.com/zhangtown/my-skills.git ~/.agents/skills');
  process.exit(1);
}
const m2 = skill.match(/ztEdit 原生格式规范（v([\d.]+)/);
if (!m2) {
  console.error('[contract-check] 实现方未找到：SKILL.md 缺少「ztEdit 原生格式规范（vX.Y）」声明');
  process.exit(1);
}

const editor = m1[1];
const skillVer = m2[1];
if (editor === skillVer) {
  console.log(`[contract-check] OK  契约 v${editor}  正本(ztEdit) = 实现方(my-skills) 一致`);
} else {
  console.error(`[contract-check] 不一致！正本(ztEdit WORKFLOW.md) = v${editor}，实现方(my-skills SKILL.md) = v${skillVer}`);
  console.error('  修改契约必须两仓同版本发布：Html-ZT-Edit「二、数据模型」+ my-skills/speech-visual-html/SKILL.md');
  process.exit(1);
}
