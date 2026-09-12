'use strict';
/*
 * router.js — Agent Team Router 路由引擎
 * 职责：把一段任务文本，匹配出合适的多角色团队编制（roster）。
 * 算法：关键词命中 + IDF 加权（抑制“数据/分析”等泛词，突出特异词），
 *       阶段（discovery/analysis/creation/assurance）分配 + 优先级 + 数量推断。
 * 纯 Node 内置模块，无外部依赖，可被 index.js（DSH 入口）直接 require。
 */

const fs = require('fs');
const path = require('path');

const PHASES = ['discovery', 'analysis', 'creation', 'assurance'];
const PHASE_LABEL = { discovery: '调研', analysis: '分析', creation: '产出', assurance: '审查' };
const PHASE_PRIORITY = { discovery: 'P0', analysis: 'P0', creation: 'P1', assurance: 'P1' };

const DEFAULT_ROLES_PATH = path.join(__dirname, 'roles.json');

// 任务阶段信号词：用于判断任务当下激活了哪些阶段
const PHASE_SIGNALS = {
  discovery: ['调研', '市场', '竞品', '趋势', '盘点', '梳理', '检索', '资料', '现状', '行业', '格局', '对标', '收集', '背景'],
  analysis: ['分析', '诊断', '评估', '对比', '测算', '建模', '洞察', 'swot', '复盘', 'kpi', '指标', '数据', '拆解'],
  creation: ['设计', '写', '生成', '方案', '制作', '开发', '产出', '策划', '文案', '脚本', '教案', '大纲', '课程', '搭建', '实现', '创作', '文档'],
  assurance: ['审查', '质检', '把关', '验收', '评审', '审核', '合规', '测试', '验证'],
};

// 规模信号词：命中后，各阶段主角色数量放大
const SCALE_WORDS = ['多', '批量', '矩阵', '全面', '系统', '分别', '团队', '大规模', '海量', '一系列', '多个', '各自', '分别针对'];

function loadRoles(rolesPath) {
  const p = rolesPath || DEFAULT_ROLES_PATH;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return raw.roles || [];
}

function isLatin(s) {
  return /^[a-z0-9 .\-]+$/i.test(s);
}

function kwAppears(kw, text) {
  if (isLatin(kw)) return text.toLowerCase().includes(kw.toLowerCase());
  return text.includes(kw);
}

// 计算 IDF：N 个角色中，含该关键词的角色数 df
function buildIdf(roles) {
  const N = roles.length;
  const df = {};
  for (const r of roles) {
    const seen = new Set();
    for (const kw of r.keywords || []) {
      if (seen.has(kw)) continue;
      seen.add(kw);
      df[kw] = (df[kw] || 0) + 1;
    }
  }
  const idf = {};
  for (const kw of Object.keys(df)) idf[kw] = Math.log(N / (1 + df[kw]));
  return idf;
}

function phaseWeights(text) {
  const w = { discovery: 0, analysis: 0, creation: 0, assurance: 0 };
  for (const p of PHASES) {
    for (const sig of PHASE_SIGNALS[p]) if (text.includes(sig)) w[p] += 1;
  }
  const total = w.discovery + w.analysis + w.creation + w.assurance;
  if (total === 0) {
    // 无信号：默认四个阶段都激活（均分权重）
    for (const p of PHASES) w[p] = 1;
  }
  return w;
}

function choosePhase(rolePhases, weights) {
  let best = rolePhases[0];
  let bestW = -1;
  for (const p of rolePhases) {
    const w = weights[p] || 0;
    if (w > bestW) { bestW = w; best = p; }
  }
  return best;
}

function confidenceOf(matched) {
  if (matched.length >= 2) return 'high';
  // 命中词较长（特异）也算 high
  const longest = matched.reduce((m, k) => Math.max(m, k.length), 0);
  return longest >= 4 ? 'high' : 'medium';
}

/**
 * 路由主函数
 * @param {string} task 任务文本
 * @param {object} opts { include:[], exclude:[], rolesPath }
 * @returns {object} roster { task, generatedAt, roles:[...] }
 */
function routeTask(task, opts) {
  opts = opts || {};
  const roles = loadRoles(opts.rolesPath);
  const idf = buildIdf(roles);
  const text = task || '';
  const weights = phaseWeights(text);
  const numMatch = text.match(/(\d+)\s*个/);
  const explicitCount = numMatch ? parseInt(numMatch[1], 10) : 0;
  const hasScale = SCALE_WORDS.some((w) => text.includes(w)) || explicitCount >= 2;

  // 1) 候选匹配
  const candidates = [];
  for (const role of roles) {
    const matched = (role.keywords || []).filter((kw) => kwAppears(kw, text));
    if (matched.length === 0) continue;
    const score = matched.reduce((s, kw) => s + (idf[kw] || 0), 0);
    candidates.push({ role, matched, score });
  }

  // 2) 排除
  const exclude = new Set((opts.exclude || []).map((s) => s.trim()).filter(Boolean));
  const filtered = candidates.filter((c) => !exclude.has(c.role.name));

  // 3) 每个阶段取主角色（用于数量放大），按阶段归集
  const byPhase = { discovery: [], analysis: [], creation: [], assurance: [] };
  for (const c of filtered) {
    const ph = choosePhase(c.role.phases, weights);
    byPhase[ph].push({ ...c, phase: ph });
  }
  const topOf = {};
  for (const ph of PHASES) {
    if (byPhase[ph].length) {
      byPhase[ph].sort((a, b) => b.score - a.score);
      topOf[ph] = byPhase[ph][0].role.name;
    }
  }

  // 4) 生成角色编制
  const rolesOut = [];
  for (const ph of PHASES) {
    for (const c of byPhase[ph]) {
      const isTop = topOf[ph] === c.role.name;
      let count = 1;
      // 规模信号（多/批量/分别 或 “N个”）下，调研与产出阶段主角色并行放大
      if (hasScale && isTop && (ph === 'discovery' || ph === 'creation')) {
        count = Math.max(3, explicitCount || 3);
      }
      rolesOut.push({
        slot: '', // 稍后统一编号
        name: c.role.name,
        domain: c.role.domain,
        phase: c.phase,
        phaseLabel: PHASE_LABEL[c.phase],
        priority: PHASE_PRIORITY[c.phase],
        count,
        duty: c.role.duty,
        acceptance: c.role.acceptance,
        handoffTo: PHASES.slice(PHASES.indexOf(c.phase) + 1),
        matchedTerms: c.matched,
        confidence: confidenceOf(c.matched),
      });
    }
  }

  // 5) --include 语义补位（模型/用户手动指定）
  for (const inc of opts.include || []) {
    const [name, ph] = inc.split(':').map((s) => s.trim());
    if (!name) continue;
    if (exclude.has(name)) continue;
    const known = roles.find((r) => r.name === name);
    const phase = (ph && PHASES.includes(ph)) ? ph : (known ? known.phases[0] : 'creation');
    rolesOut.push({
      slot: '',
      name,
      domain: known ? known.domain : 'custom',
      phase,
      phaseLabel: PHASE_LABEL[phase],
      priority: 'P0',
      count: 1,
      duty: known ? known.duty : `按指令承担「${name}」职责`,
      acceptance: known ? known.acceptance : '完成指定交付物',
      handoffTo: PHASES.slice(PHASES.indexOf(phase) + 1),
      matchedTerms: [],
      confidence: 'manual',
    });
  }

  // 6) 兜底审查角色：若没有任何 assurance 角色，自动补一个质量审查员
  if (!rolesOut.some((r) => r.phase === 'assurance')) {
    const qa = roles.find((r) => r.name === 'Quality Reviewer') || {
      name: 'Quality Reviewer', domain: 'assurance', duty: '质量审查、风险把关与门禁校验', acceptance: '产出明确通过/返工判决与 findings',
    };
    rolesOut.push({
      slot: '', name: qa.name, domain: qa.domain, phase: 'assurance', phaseLabel: '审查',
      priority: 'P1', count: 1, duty: qa.duty, acceptance: qa.acceptance,
      handoffTo: [], matchedTerms: [], confidence: 'auto',
    });
  }

  // 7) 排序：阶段顺序 → score 降序；统一编号
  rolesOut.sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || 0);
  rolesOut.forEach((r, i) => { r.slot = `r${i + 1}`; });

  return { task, generatedAt: new Date().toISOString(), roles: rolesOut };
}

function catalog(rolesPath) {
  const roles = loadRoles(rolesPath);
  const byDomain = {};
  for (const r of roles) (byDomain[r.domain] = byDomain[r.domain] || []).push(r);
  return byDomain;
}

// ----------------- CLI -----------------
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--catalog')) {
    const byDomain = catalog(args.includes('--roles') ? args[args.indexOf('--roles') + 1] : undefined);
    for (const d of Object.keys(byDomain)) {
      console.log(`\n# 域: ${d}`);
      for (const r of byDomain[d]) console.log(`  - ${r.name} [${r.phases.join('/')}] : ${r.duty}`);
    }
    process.exit(0);
  }
  const task = args.find((a) => !a.startsWith('--'));
  if (!task) { console.error('用法: node router.js "<任务文本>" [--include "角色:阶段"] [--exclude "a,b"] [--out roster.json]'); process.exit(1); }

  const getOpt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const include = (getOpt('--include') || '').split(';').map((s) => s.trim()).filter(Boolean);
  const exclude = (getOpt('--exclude') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const out = getOpt('--out') || 'roster.json';
  const rolesPath = getOpt('--roles');

  const roster = routeTask(task, { include, exclude, rolesPath });
  fs.writeFileSync(out, JSON.stringify(roster, null, 2), 'utf8');
  console.log(`✓ 路由完成，命中 ${roster.roles.length} 个角色，已写入 ${out}`);
  for (const r of roster.roles) {
    console.log(`  ${r.slot} [${r.priority}] ${r.phaseLabel} ${r.name} ×${r.count} (${r.confidence})`);
  }
}

module.exports = { routeTask, loadRoles, catalog, PHASES, PHASE_LABEL };
