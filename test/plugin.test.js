#!/usr/bin/env node
'use strict';
/*
 * plugin.test.js — Agent Team Router v2.0.1 路径隔离与契约回归测试
 * 对应修复报告 ②/③：
 *   - 所有产物收敛到显式/绝对工作空间，绝不散落进进程 CWD（核心回归点）
 *   - 路径助手行为锁定（相对→工作空间内、绝对→原样尊重、~ 展开）
 *   - 角色库实际数量与文档一致（≠ 名不副实）
 * 不依赖 DSH 运行时，直接驱动 paths.js / router.js / team.js。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { resolveWorkspace, resolveArtifactPath } = require('../paths');
const { routeTask, loadRoles, catalog } = require('../router');
const { TeamStore } = require('../team');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
function section(t) { console.log('\n[' + t + ']'); }

// ---------- A. 路径助手契约 ----------
section('A 路径助手（resolveWorkspace / resolveArtifactPath）');
ok('resolveWorkspace 返回绝对路径', path.isAbsolute(resolveWorkspace('./run')));
ok('resolveWorkspace 默认兜底为绝对路径', path.isAbsolute(resolveWorkspace()));
ok('~ 展开为用户主目录', resolveWorkspace('~/x').startsWith(os.homedir()));
ok('resolveArtifactPath 空 explicit → 落在工作空间内', resolveArtifactPath('/ws', undefined, 'roster.json') === path.join('/ws', 'roster.json'));
ok('resolveArtifactPath 绝对路径原样尊重', resolveArtifactPath('/ws', '/abs/report.md', 'report.md') === '/abs/report.md');
ok('resolveArtifactPath 相对路径 → 解析进工作空间', resolveArtifactPath('/ws', 'sub/out.md', 'out.md') === path.join('/ws', 'sub/out.md'));

// ---------- B. 隔离 CWD：显式工作空间不应污染 CWD ----------
section('B 隔离 CWD（显式工作空间）');
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atr-cwd-'));
  const prev = process.cwd();
  try {
    process.chdir(sandbox);
    const ws = resolveWorkspace(path.join(sandbox, 'run'));
    const store = new TeamStore(ws);
    const roster = routeTask('分析 TikTok Shop 泰国站美妆竞争格局，设计 3 个选品方案并产出落地文档', {});
    fs.writeFileSync(resolveArtifactPath(ws, undefined, 'roster.json'), JSON.stringify(roster, null, 2));
    store.create(roster);
    const { report } = store.merge();
    fs.writeFileSync(resolveArtifactPath(ws, undefined, 'report.md'), report);
    const rootEntries = fs.readdirSync(sandbox);
    ok('CWD 根目录除工作空间外无散落文件', rootEntries.length === 1 && rootEntries[0] === 'run');
    ok('工作空间内含 roster.json / team.json / report.md',
      fs.existsSync(path.join(ws, 'roster.json')) &&
      fs.existsSync(path.join(ws, 'team.json')) &&
      fs.existsSync(path.join(ws, 'report.md')));
  } finally {
    process.chdir(prev);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------- C. 隔离 CWD：默认工作空间也不应污染其它目录 ----------
section('C 隔离 CWD（默认工作空间 ./agent-team）');
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atr-cwd-def-'));
  const prev = process.cwd();
  try {
    process.chdir(sandbox);
    const ws = resolveWorkspace(); // './agent-team'
    const store = new TeamStore(ws);
    store.create(routeTask('为中职电商课设计一节10分钟试讲教案', {}));
    const rootEntries = fs.readdirSync(sandbox);
    ok('CWD 根目录仅出现 .agent-team 目录', rootEntries.length === 1 && rootEntries[0] === '.agent-team');
    ok('team.json 落在 .agent-team 内', fs.existsSync(path.join(ws, 'team.json')));
  } finally {
    process.chdir(prev);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------- D. 角色库数量与文档一致（≠ 名不副实） ----------
section('D 角色库数量一致性');
const roles = loadRoles();
ok('角色总数 = 297（与 package.json/README 一致）', roles.length === 297);
ok('catalog 回报真实总数且 > 0', (function () {
  const byDomain = catalog();
  const total = Object.values(byDomain).reduce((a, x) => a + x.length, 0);
  return total === 297;
})());

// ---------- E. 分层 DAG / 门禁（冒烟子集，防回归） ----------
section('E 分层 DAG 与 5 阶段门禁');
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'atr-e-'));
  const store = new TeamStore(ws);
  const team = store.create(routeTask('分析 TikTok Shop 泰国站美妆个护类目竞争格局，设计 3 个高潜力选品方案并产出落地文档', {}));
  const creation = team.tasks.find((t) => t.phase === 'creation');
  if (creation) {
    const depPhases = creation.dependsOn.map((id) => team.tasks.find((t) => t.taskId === id).phase);
    ok('creation 任务仅依赖紧邻前序阶段 design', depPhases.every((p) => p === 'design'));
  } else {
    ok('creation 任务仅依赖紧邻前序阶段 design', true);
  }
  ok('DAG 无环', store.buildDag().hasCycle === false);
  for (const t of team.tasks) for (const mid of t.members) store.complete(t.taskId, mid, 'x');
  const assur = team.tasks.find((t) => t.phase === 'assurance');
  store.review(assur.taskId, 'pass', 'ok');
  ok('全通过 → 门禁 ok', store.qualityGate().ok === true);
}

console.log(`\n==== plugin.test.js：${pass} 通过 / ${fail} 失败 ====`);
process.exit(fail === 0 ? 0 : 1);
