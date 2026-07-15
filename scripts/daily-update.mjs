/**
 * 每日案例库自动更新脚本(由 .github/workflows/daily-update.yml 定时执行)
 *
 * 每次运行:
 *   1. 若配置了 ANTHROPIC_API_KEY(仓库 Secret),调用 Claude API 生成 2 条新的热门钩子;
 *      未配置或调用失败时,从 data/reserve.json 的备用池中取 2 条。
 *   2. 从备用池取 1 条品牌案例、1 条 TVC 脚本(取完即止,池空则跳过)。
 *   3. 更新 data/hooks-data.js 里的数据与 updated 日期。
 *
 * 本地手动运行:node scripts/daily-update.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = join(ROOT, 'data', 'hooks-data.js');
const RESERVE_FILE = join(ROOT, 'data', 'reserve.json');

const HOOK_TYPES = ['悬念好奇', '痛点直击', '身份点名', '利益承诺', '反差冲突', '恐惧损失', '数字冲击', '权威背书', '场景代入', '争议站队', '剧情冲突', '福利促销'];

function loadData() {
  const src = readFileSync(DATA_FILE, 'utf8');
  const m = src.match(/window\.HOOKS_DATA = (\{[\s\S]*\});/);
  if (!m) throw new Error('无法解析 ' + DATA_FILE);
  return JSON.parse(m[1]);
}

function saveData(data) {
  writeFileSync(
    DATA_FILE,
    '/* 钩子案例库数据 — 由 scripts/daily-update.mjs 每日自动更新,也可手工编辑(保持 JSON 结构)*/\n' +
      'window.HOOKS_DATA = ' + JSON.stringify(data, null, 2) + ';\n'
  );
}

function beijingDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function generateWithClaude(existingHooks) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const prompt = `你是资深信息流广告文案专家。请为抖音信息流广告写 2 条"黄金三秒"开场钩子文案。

要求:
- 每条 15~35 字,口语化、有停留感,不出现具体品牌名
- type 必须从以下列表中选择:${HOOK_TYPES.join('、')}
- reason 用一句话拆解这条钩子为什么有效(30~60 字)
- 不要与以下已有钩子重复或高度相似:
${existingHooks.slice(-20).map((h) => '  - ' + h).join('\n')}

只输出一个严格合法的 JSON 数组,不要任何其他文字:
[{"hook": "...", "type": "...", "reason": "..."}, {"hook": "...", "type": "...", "reason": "..."}]`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      console.error('Claude API 请求失败:', res.status, await res.text());
      return null;
    }
    const msg = await res.json();
    if (msg.stop_reason === 'refusal') return null;
    const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;
    const arr = JSON.parse(jsonMatch[0]);
    return arr.filter(
      (x) =>
        x && typeof x.hook === 'string' && x.hook.length >= 6 &&
        HOOK_TYPES.includes(x.type) && typeof x.reason === 'string'
    );
  } catch (err) {
    console.error('Claude API 调用异常:', err.message);
    return null;
  }
}

const data = loadData();
const reserve = JSON.parse(readFileSync(RESERVE_FILE, 'utf8'));
const existingHooks = new Set(data.trending.map((t) => t.hook));
const added = [];

// 1. 热门钩子:优先 AI 生成,失败则从备用池取
const aiHooks = await generateWithClaude([...existingHooks]);
if (aiHooks && aiHooks.length) {
  for (const item of aiHooks) {
    if (!existingHooks.has(item.hook)) {
      data.trending.push({ hook: item.hook, type: item.type, reason: item.reason });
      existingHooks.add(item.hook);
      added.push('AI 热门钩子:' + item.hook);
    }
  }
}
if (!added.length) {
  for (const item of reserve.trending.splice(0, 2)) {
    if (!existingHooks.has(item.hook)) {
      data.trending.push(item);
      existingHooks.add(item.hook);
      added.push('备用热门钩子:' + item.hook);
    }
  }
}

// 2. 品牌案例 + TVC:各从备用池取 1 条
const nextCase = reserve.cases.shift();
if (nextCase) {
  data.cases.push(nextCase);
  added.push('品牌案例:' + nextCase.brand);
}
const nextTvc = reserve.tvc.shift();
if (nextTvc) {
  data.tvc.push(nextTvc);
  added.push('TVC 脚本:' + nextTvc.brand);
}

if (!added.length) {
  console.log('备用池已空且 AI 未生成新内容,本次无更新。');
  process.exit(0);
}

data.updated = beijingDate();
saveData(data);
writeFileSync(RESERVE_FILE, JSON.stringify(reserve, null, 2) + '\n');

console.log(`更新完成(${data.updated}),新增 ${added.length} 条:`);
for (const line of added) console.log('  + ' + line);
console.log(`当前库存:热门 ${data.trending.length} / 案例 ${data.cases.length} / TVC ${data.tvc.length}`);
console.log(`备用池剩余:热门 ${reserve.trending.length} / 案例 ${reserve.cases.length} / TVC ${reserve.tvc.length}`);
