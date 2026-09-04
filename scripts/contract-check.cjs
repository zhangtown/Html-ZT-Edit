// 校验 ztEdit 原生格式契约的版本一致性：
//   正本：本仓库 WORKFLOW.md「二、数据模型」（当前契约版本 vX.Y）
//   实现方：speech-visual-html/SKILL.md「ztEdit 原生格式规范（vX.Y）」
//
// 默认读本仓库已入库的副本 speech-visual-html/SKILL.md（稳定存在，不依赖换机后手动克隆的
// ~/.agents/skills）。如果本机另有 ~/.agents/skills 中央库，也会顺带检查它是否一致，
// 防止副本与中央库漂移。可用 --skill-path 强制指定。
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const skillPathIdx = args.indexOf('--skill-path');
const bundledSkillMd = path.join(repoRoot, 'speech-visual-html', 'SKILL.md');
const centralSkillMd = path.join(os.homedir(), '.agents', 'skills', 'speech-visual-html', 'SKILL.md');
const skillMd =
  skillPathIdx >= 0
    ? path.resolve(args[skillPathIdx + 1], 'SKILL.md')
    : bundledSkillMd;

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
  process.exit(1);
}
const m2 = skill.match(/ztEdit 原生格式规范（v([\d.]+)/);
if (!m2) {
  console.error('[contract-check] 实现方未找到：SKILL.md 缺少「ztEdit 原生格式规范（vX.Y）」声明');
  process.exit(1);
}

const editor = m1[1];
const skillVer = m2[1];
let failed = false;
if (editor === skillVer) {
  console.log(`[contract-check] OK  契约 v${editor}  正本(ztEdit) = 实现方(${path.relative(repoRoot, skillMd)}) 一致`);
} else {
  console.error(`[contract-check] 不一致！正本(ztEdit WORKFLOW.md) = v${editor}，实现方(${path.relative(repoRoot, skillMd)}) = v${skillVer}`);
  console.error('  修改契约必须两仓同版本发布：Html-ZT-Edit「二、数据模型」+ my-skills/speech-visual-html/SKILL.md');
  failed = true;
}

// 若本机存在 ~/.agents/skills 中央库且读的不是它，顺带交叉检查一次（不一致给出警告但不致命，
// 因为中央库可能只是还没同步；真正的数据源是本仓库副本）
if (skillMd !== centralSkillMd && fs.existsSync(centralSkillMd)) {
  try {
    const central = fs.readFileSync(centralSkillMd, 'utf8');
    const m3 = central.match(/ztEdit 原生格式规范（v([\d.]+)/);
    if (m3 && m3[1] !== editor) {
      console.warn(`[contract-check] ⚠ 本机中央库(${centralSkillMd}) 契约 v${m3[1]} 与正本 v${editor} 不一致，可能是中央库尚未同步`);
    } else if (m3) {
      console.log(`[contract-check] OK  本机中央库契约同为 v${m3[1]}`);
    }
  } catch {}
}

process.exit(failed ? 1 : 0);
