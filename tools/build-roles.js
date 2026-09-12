#!/usr/bin/env node
'use strict';
/*
 * build-roles.js — 从 agency-agents 角色库抽取角色，合并进 roles.json
 *
 * 输入：~/.workbuddy/skills/agency-agents 下所有 agent .md（YAML frontmatter: name/description）
 * 输出：../roles.json（与现有精选角色合并去重，精选优先）
 *
 * 字段映射：
 *   name        <- frontmatter.name
 *   domain      <- 父目录名
 *   phases      <- 依据 name+description 启发式推断
 *   keywords    <- name 分词 + description 显著词 + 域中文别名
 *   duty        <- description（截断）
 *   acceptance  <- 按主阶段生成的验收要点
 */

const fs = require('fs');
const path = require('path');

const AGENCY_DIR = process.argv[2] ||
  path.join(process.env.HOME || process.env.USERPROFILE, '.workbuddy/skills/agency-agents');
const OUT = path.join(__dirname, '..', 'roles.json');

const STOP = new Set((
  'the a an and or of to for in on with by from as at is are be this that these those it its their ' +
  'our your we you they he she can will should may must do does done using use used based via per into ' +
  'out up down over under between within without about against across after before during not no nor so ' +
  'such then than too very just also more most other some any all each both few many much one two three ' +
  'new old first last same different own your our their his her how what when where why who which while ' +
  'you your able able across action agent agents approach area areas around best build built business ' +
  'call called care case cases change client clients company companies complete complex concept create ' +
  'created creation custom data design details develop developed development device different digital ' +
  'directly edge effective effort end ensure example experience expert expertise fact factors field ' +
  'focus focused form free full function general global goal good great group high important include ' +
  'including increase information initial input instance issues key knowledge large lead leading learn ' +
  'level levels light line list local long look main make making manage management manager market ' +
  'materials means measure media method methods model models need needs network new offer offline online ' +
  'open operations opportunity option options order organization output overall package part particular ' +
  'pattern performance plan platform player point points power practice press primary problem process ' +
  'product production professional program project provide provided quality question quick range rate ' +
  'real reason receive recent record reduce region related relationship remain remember require required ' +
  'requirements response result results return right role rules safe scale scene score section secure ' +
  'see select service services set shape share short show side simple single site size small social ' +
  'software solution solutions source space specific specifically stage stand standard standards state ' +
  'step steps still store story strategy strong structure support system systems team technical technology ' +
  'term test thing things think time times title top trace track training true turn type types understand ' +
  'unique unit use used user users using various view visual want way ways work working works world write'
).split(/\s+/).filter(Boolean));

// 域 → 中文别名（让 agency 角色在中文任务下也能成为候选，由 router 的 IDF 决定特异性）
const DOMAIN_CN = {
  marketing: ['营销', '推广', '品牌', '社媒', '增长', '获客', '内容', '投放'],
  ecommerce: ['电商', '跨境', '出海', '选品', '店铺', '零售'],
  research: ['调研', '研究', '分析', '情报', '文献'],
  design: ['设计', '视觉', '品牌', '交互', '原型'],
  product: ['产品', '需求', '规划', 'pm', '原型'],
  engineering: ['工程', '开发', '代码', '架构', '后端', '前端', '全栈'],
  writing: ['写作', '文案', '内容', '编辑', '创作'],
  sales: ['销售', '转化', '客户', '成交', '线索'],
  finance: ['财务', '金融', '预算', '估值', '投资', '风控'],
  analysis: ['分析', '数据', '建模', '洞察', '指标'],
  strategy: ['战略', '策略', '规划', '决策', '增长'],
  assurance: ['审查', '质检', '测试', '验收', '合规', '把关'],
  academic: ['学术', '科研', '论文', '课题'],
  security: ['安全', '渗透', '风控', '合规', '防护'],
  healthcare: ['医疗', '健康', '临床', '生物'],
  'game-development': ['游戏', '引擎', '关卡', '美术'],
  gis: ['地图', '地理', '空间'],
  'spatial-computing': ['空间', '三维', 'vr'],
  'project-management': ['项目管理', '排期', '敏捷', '交付', '协作'],
  testing: ['测试', 'qa', '自动化', '质量'],
  support: ['客服', '支持', '工单', '售后'],
  'paid-media': ['投放', '广告', '竞价', '信息流'],
};

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (mm) fm[mm[1]] = mm[2].trim();
  }
  return fm;
}

function nameTokens(name) {
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_/]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP.has(w));
  return [...new Set(parts)];
}

function descKeywords(desc) {
  const words = desc
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 5 && /[a-z]/.test(w) && !STOP.has(w));
  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (!seen.has(w)) { seen.add(w); out.push(w); }
    if (out.length >= 16) break;
  }
  return out;
}

function inferPhases(name, desc) {
  const s = (name + ' ' + desc).toLowerCase();
  const has = (arr) => arr.some((w) => s.includes(w));
  const PH = {
    disc: ['research', 'researcher', 'analyst', 'analysis', 'analytics', 'strategist', 'strategy',
      'planner', 'planning', 'investigat', 'survey', 'intelligence', 'synthes', 'scout', 'discover',
      'collect', 'explor', 'audit', 'study', 'evaluator'],
    design: ['design', 'designer', 'architect', 'ux', 'ui', 'brand', 'creative', 'wireframe',
      'prototype', 'prototyping', 'visual', 'layout', 'concept', 'modeler', 'planner'],
    creation: ['developer', 'engineer', 'writer', 'author', 'creator', 'content', 'copy', 'build',
      'builder', 'implement', 'coder', 'programmer', 'maker', 'producer', 'editor', 'compose',
      'compose', 'dev', 'crafter', 'specialist'],
    assurance: ['reviewer', 'review', 'qa', 'tester', 'test', 'audit', 'quality', 'validator',
      'verification', 'compliance', 'check', 'inspector'],
  };
  const phases = [];
  if (has(PH.disc)) phases.push('discovery', 'analysis');
  if (has(PH.design)) phases.push('design');
  if (has(PH.creation)) phases.push('creation');
  if (has(PH.assurance)) phases.push('assurance');
  if (phases.length === 0) phases.push('discovery', 'analysis', 'creation');
  return [...new Set(phases)];
}

function acceptanceFor(phases, name) {
  const primary = phases[0];
  if (primary === 'assurance') return `给出明确 pass/reject 判决与具体 findings，质量门禁闭环`;
  if (primary === 'creation') return `产出可直接使用的最终交付物，覆盖角色「${name}」核心职责`;
  if (primary === 'design') return `产出可落地的方案/架构/原型，明确下一阶段执行路径`;
  if (primary === 'analysis') return `产出可溯源的洞察与结论，支撑后续设计/产出`;
  return `产出该阶段所需的事实与材料，并通过阶段出口校验`;
}

function extractAgency() {
  if (!fs.existsSync(AGENCY_DIR)) {
    console.error('✗ agency-agents 目录不存在:', AGENCY_DIR);
    process.exit(1);
  }
  const roles = [];
  for (const division of fs.readdirSync(AGENCY_DIR)) {
    const ddir = path.join(AGENCY_DIR, division);
    if (!fs.statSync(ddir).isDirectory()) continue;
    if (division === 'examples') continue;
    for (const file of fs.readdirSync(ddir)) {
      if (!file.endsWith('.md')) continue;
      const text = fs.readFileSync(path.join(ddir, file), 'utf8');
      const fm = parseFrontmatter(text);
      if (!fm.name) continue;
      const desc = fm.description || '';
      const domain = division;
      const phases = inferPhases(fm.name, desc);
      const cn = DOMAIN_CN[domain] || [domain];
      const keywords = [
        ...nameTokens(fm.name),
        ...descKeywords(desc),
        ...cn,
      ];
      roles.push({
        name: fm.name,
        domain,
        phases,
        keywords: [...new Set(keywords)],
        duty: desc.length > 220 ? desc.slice(0, 217) + '...' : desc,
        acceptance: acceptanceFor(phases, fm.name),
        _src: 'agency',
      });
    }
  }
  return roles;
}

function main() {
  const agency = extractAgency();
  // 读取现有精选角色（保留，中文关键词更准）
  let curated = [];
  if (fs.existsSync(OUT)) {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    curated = (prev.roles || []).map((r) => ({ ...r, _src: 'curated' }));
  }
  // 合并去重：同名（忽略大小写）以 curated 优先
  const byKey = new Map();
  for (const r of curated) byKey.set(r.name.toLowerCase(), r);
  let added = 0;
  for (const r of agency) {
    const k = r.name.toLowerCase();
    if (!byKey.has(k)) { byKey.set(k, r); added++; }
  }
  const merged = [...byKey.values()].map(({ _src, ...rest }) => rest);

  const domains = {};
  for (const r of merged) domains[r.domain] = (domains[r.domain] || 0) + 1;

  const out = {
    _meta: {
      version: '2.0.0',
      description: 'Agent Team Router 角色库 v2：合并 agency-agents 273+ 专业角色 + 精选中文域角色。' +
        '覆盖营销/电商/研究/设计/产品/工程/写作/分析/战略/教育/金融/安全等域。字段：phases(擅长阶段)、' +
        'keywords(中英文匹配词)、duty(分工)、acceptance(验收要点)。阶段取值：discovery=调研、analysis=分析、' +
        'design=设计、creation=产出、assurance=审查。',
      phases: ['discovery', 'analysis', 'design', 'creation', 'assurance'],
      generatedAt: new Date().toISOString(),
      counts: { total: merged.length, curated: curated.length, agencyAdded: added },
    },
    roles: merged,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(`✓ 生成 roles.json：总计 ${merged.length} 角色（精选 ${curated.length} + 新增 agency ${added}）`);
  console.log('  域分布:', JSON.stringify(domains, null, 0));
}

main();
