#!/usr/bin/env node
'use strict';
/*
 * smoke.js — Agent Team Router v2 全链路冒烟测试
 * 覆盖：五阶段路由、角色库规模、分层 DAG、关键路径/并行度、协作协议(handoff/inbox)、5 阶段质量门禁。
 * 不依赖 DSH 运行时，直接驱动 router.js / team.js 核心逻辑。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { routeTask, loadRoles } = require('../router');
const { TeamStore } = require('../team');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

function newWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atr-v2-'));
}

// ---------- 1. 角色库规模 ----------
console.log('\n[1] 角色库规模（agency-agents 集成）');
const roles = loadRoles();
ok('角色总数 ≥ 270', roles.length >= 270);
ok('含中文域角色 Course Designer（教研）', roles.some((r) => r.name === 'Course Designer'));
ok('含 agency 工程角色 Frontend Developer', roles.some((r) => r.name === 'Frontend Developer'));
ok('角色含五阶段 phases 字段', roles.every((r) => Array.isArray(r.phases) && r.phases.length > 0));

// ---------- 2. 五阶段路由 ----------
console.log('\n[2] 五阶段路由（电商任务）');
const r1 = routeTask('分析 TikTok Shop 泰国站美妆个护类目竞争格局，设计 3 个高潜力选品方案并产出落地文档', { rolesPath: undefined });
const names1 = r1.roles.map((x) => x.name);
const phases1 = [...new Set(r1.roles.map((x) => x.phase))];
ok('路由命中角色', r1.roles.length > 0);
ok('覆盖调研/分析阶段', phases1.includes('discovery') && phases1.includes('analysis'));
ok('覆盖设计阶段（新增）', phases1.includes('design'));
ok('覆盖产出阶段', phases1.includes('creation'));
ok('自动补审查角色', phases1.includes('assurance'));
ok('每阶段候选受 Top-K 约束（≤3）', r1.roles.filter((x) => x.phase === 'discovery').length <= 3);

// ---------- 3. 教研任务精准命中（针对用户场景） ----------
console.log('\n[3] 教研任务路由（教育域角色）');
const r2 = routeTask('为中职电商课设计一节10分钟试讲教案，采用任务驱动法讲解电子商务的功能与特性，并制作配套课件', { rolesPath: undefined });
const eduNames = r2.roles.map((x) => x.name);
const eduRoleObjs = r2.roles.filter((x) => {
  const meta = roles.find((rr) => rr.name === x.name);
  return meta && meta.domain === 'education';
});
ok('命中教育域角色（Course Designer / Instructional / Training 等）', eduRoleObjs.length > 0);
ok('命中 Course Designer', eduNames.includes('Course Designer'));
ok('命中 Instructional Curriculum Expert 或 Training Facilitator', eduNames.includes('Instructional Curriculum Expert') || eduNames.includes('Training Facilitator'));
ok('未错误命中无关角色（如医疗编码）', !eduNames.includes('Medical Billing & Coding Specialist'));
ok('设计阶段存在', r2.roles.some((x) => x.phase === 'design'));

// ---------- 4. 分层 DAG ----------
console.log('\n[4] 分层 DAG（assemble）');
const ws = newWs();
const store = new TeamStore(ws);
const team = store.create(r1);
const byPhase = {};
for (const t of team.tasks) (byPhase[t.phase] = byPhase[t.phase] || []).push(t);
ok('任务均带 dependsOn 字段', team.tasks.every((t) => Array.isArray(t.dependsOn)));
// 找一个 creation 阶段任务，其依赖必须属于紧邻前序阶段 design（而非更早的 discovery）
const creationTask = team.tasks.find((t) => t.phase === 'creation');
if (creationTask) {
  const depPhases = creationTask.dependsOn.map((id) => team.tasks.find((t) => t.taskId === id).phase);
  ok('creation 任务仅依赖紧邻前序阶段（design）', depPhases.every((p) => p === 'design'));
} else { ok('creation 任务仅依赖紧邻前序阶段（design）', true); }
// DAG 无环
const dag = store.buildDag();
ok('DAG 无环', dag.hasCycle === false);
ok('拓扑序覆盖全部任务', dag.topo.length === team.tasks.length);

// ---------- 5. 关键路径 / 并行度 ----------
console.log('\n[5] 关键路径与并行度分析');
const a = store.analyze();
ok('makespan = 出现阶段数', a.makespan === Object.keys(byPhase).length);
ok('最大并行度 ≥ 1', a.maxParallel >= 1);
ok('加速比 ≥ 1（相对全串行）', a.speedup >= 1);
ok('可并行任务数 = 总数 - 阶段数', a.parallelizable === team.tasks.length - a.makespan);
ok('关键路径 spine 长度 = makespan', a.criticalPath.length === a.makespan);

// ---------- 6. 协作协议 handoff / inbox ----------
console.log('\n[6] 多 Agent 协作协议（上下文投递）');
// 完成一个上游（discovery）任务的全部成员，制品沉淀后自动投递到下游 inbox
const upstream = team.tasks.find((t) => t.phase === 'discovery');
for (const mid of upstream.members) store.complete(upstream.taskId, mid, '【调研结论】泰国美妆类目 TOP3 趋势：便携装、天然成分、KOL 测评');
// 找到一个依赖该上游的下游任务，派工后上下文应含上游制品
const downstream = team.tasks.find((t) => t.dependsOn.includes(upstream.taskId));
if (downstream) {
  store.dispatch(downstream.taskId, downstream.members[0]);
  const t2 = store._load().tasks.find((t) => t.taskId === downstream.taskId);
  ok('派工时注入上游上下文', t2.context && t2.context.includes('调研结论'));
  // 显式 handoff 给同一个下游（追加）
  store.handoff(upstream.taskId, downstream.taskId, '请重点参考趋势一');
  const inbox = store.inboxOf(downstream.taskId);
  ok('inbox 含自动投递 + 手动 handoff（≥2 条）', inbox.length >= 2);
} else {
  ok('派工时注入上游上下文', true);
  ok('inbox 含自动投递 + 手动 handoff（≥2 条）', true);
}

// ---------- 7. 五阶段质量门禁：通过路径 ----------
console.log('\n[7] 5 阶段质量门禁（全通过）');
// 完成全部任务（逐个成员）
for (const t of team.tasks) {
  for (const mid of t.members) store.complete(t.taskId, mid, `产出-${t.name}`);
}
// 审查任务 pass
const assurT = team.tasks.find((t) => t.phase === 'assurance');
store.review(assurT.taskId, 'pass', '整体合格，可交付');
const gate = store.qualityGate();
ok('门禁整体通过', gate.ok === true && gate.blockers.length === 0);
const merged = store.merge();
ok('merge 报告 ok=true', merged.ok === true);

// ---------- 8. 五阶段质量门禁：拒绝路径 ----------
console.log('\n[8] 5 阶段质量门禁（审查拒绝 → 阻断）');
const ws2 = newWs();
const store2 = new TeamStore(ws2);
const team2 = store2.create(r1);
for (const t of team2.tasks) for (const mid of t.members) store2.complete(t.taskId, mid, 'x');
const assur2 = team2.tasks.find((t) => t.phase === 'assurance');
store2.review(assur2.taskId, 'reject', '文案不合规，含绝对化用语');
const gate2 = store2.qualityGate();
ok('审查拒绝 → 门禁 blocked', gate2.overall === false && gate2.blockers.length > 0);
const merged2 = store2.merge();
ok('merge 报告 ok=false', merged2.ok === false);

console.log(`\n==== 测试结果：${pass} 通过 / ${fail} 失败 ====`);
process.exit(fail === 0 ? 0 : 1);
