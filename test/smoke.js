'use strict';
/* 本地冒烟测试：无需 dsh 运行时，验证路由 + 团队状态机全链路逻辑。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { routeTask, catalog } = require('../router');
const { TeamStore } = require('../team');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

const ROOT = path.join(__dirname, '..');

// ---------- 1. 电商任务路由 ----------
console.log('\n[1] 电商任务路由');
const r1 = routeTask('分析 TikTok Shop 泰国站美妆个护类目竞争格局，给 3 个高潜力选品方向', { rolesPath: path.join(ROOT, 'roles.json') });
const names1 = r1.roles.map((r) => r.name);
ok('命中 TikTok Strategist', names1.includes('TikTok Strategist'));
ok('命中 Cross-Border E-Commerce Specialist', names1.includes('Cross-Border E-Commerce Specialist'));
ok('阶段按 discovery→assurance 排序', (() => {
  const order = r1.roles.map((r) => ['discovery', 'analysis', 'creation', 'assurance'].indexOf(r.phase));
  return order.every((v, i) => i === 0 || order[i - 1] <= v);
})());
ok('含兜底 Quality Reviewer（assurance）', names1.includes('Quality Reviewer'));
ok('规模信号触发主角色 count=3', r1.roles.some((r) => r.count === 3));

// ---------- 2. 教研任务路由（关键：教育域角色应命中）----------
console.log('\n[2] 教研任务路由（教育域角色）');
const r2 = routeTask('为中职电商课设计一节10分钟试讲教案，采用任务驱动法讲解电子商务的功能与特性', { rolesPath: path.join(ROOT, 'roles.json') });
const names2 = r2.roles.map((r) => r.name);
ok('命中 Course Designer', names2.includes('Course Designer'));
ok('命中 Instructional Curriculum Expert（任务驱动命中）', names2.includes('Instructional Curriculum Expert'));
ok('命中 Training Facilitator', names2.includes('Training Facilitator'));
ok('未错误命中 Drupal/医疗等无关角色', !names2.includes('Medical Billing & Coding Specialist'));

// ---------- 3. --include 手动补位 ----------
console.log('\n[3] --include 语义补位');
const r3 = routeTask('写一份产品说明书', { include: ['Technical Writer:creation'], rolesPath: path.join(ROOT, 'roles.json') });
ok('include 角色被加入', r3.roles.some((r) => r.name === 'Technical Writer' && r.confidence === 'manual'));

// ---------- 4. --exclude 排除 ----------
console.log('\n[4] --exclude 排除');
const r4 = routeTask('分析 TikTok Shop 竞争格局', { exclude: ['TikTok Strategist'], rolesPath: path.join(ROOT, 'roles.json') });
ok('被排除角色不存在', !r4.roles.map((r) => r.name).includes('TikTok Strategist'));

// ---------- 5. 团队状态机全链路 ----------
console.log('\n[5] 团队状态机：建队→派工→完成→审查→汇总');
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'atr-smoke-'));
const store = new TeamStore(ws);
const roster = routeTask('为中职电商课设计一节10分钟试讲教案：电子商务的功能与特性', { rolesPath: path.join(ROOT, 'roles.json') });
const team = store.create(roster);
ok('成员数 = Σ count', team.members.length === roster.roles.reduce((s, r) => s + r.count, 0));
ok('任务数 = 角色数', team.tasks.length === roster.roles.length);
ok('discovery 任务无依赖', team.tasks.filter((t) => t.phase === 'discovery').every((t) => t.dependsOn.length === 0));
ok('依赖不变量：任务仅依赖更早阶段的任务', team.tasks.every((t) => {
  const myIdx = ['discovery', 'analysis', 'creation', 'assurance'].indexOf(t.phase);
  return t.dependsOn.every((d) => {
    const dep = team.tasks.find((x) => x.taskId === d);
    return dep && ['discovery', 'analysis', 'creation', 'assurance'].indexOf(dep.phase) < myIdx;
  });
}));

// 模拟：按阶段顺序完成所有任务
const byPhaseOrder = ['discovery', 'analysis', 'creation', 'assurance'];
for (const ph of byPhaseOrder) {
  const tasks = team.tasks.filter((t) => t.phase === ph);
  for (const t of tasks) {
    for (const mid of t.members) {
      store.dispatch(t.taskId, mid);
      store.complete(t.taskId, mid, `产出-${t.name}-${mid}`);
    }
  }
}
// 审查阶段任务给 verdict
const assurance = team.tasks.find((t) => t.phase === 'assurance');
store.review(assurance.taskId, 'pass', '审查通过，内容符合教学目标');
ok('审查后 verdict=pass', store._load().tasks.find((t) => t.taskId === assurance.taskId).verdict === 'pass');

const st = store.status();
ok('全部任务完成', st.completed === st.tasks);

const { report, blockers, ok: mergeOk } = store.merge();
ok('merge 无阻断项', blockers.length === 0 && mergeOk);
ok('报告含“交付报告”标题', report.includes('# 团队协作交付报告'));
ok('报告含审查意见', report.includes('审查意见'));

// ---------- 6. 门禁拦截（产出未完成）----------
console.log('\n[6] 质量门禁：缺失产出应报阻断项');
const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'atr-smoke2-'));
const store2 = new TeamStore(ws2);
const team2 = store2.create(routeTask('写一份课程大纲', { rolesPath: path.join(ROOT, 'roles.json') }));
// 不完成任何任务直接 merge
const m2 = store2.merge();
ok('未完成任务 merge 报阻断项', m2.blockers.length > 0 && !m2.ok);

// ---------- 7. 角色库完整性 ----------
console.log('\n[7] 角色库完整性');
const byDomain = catalog(path.join(ROOT, 'roles.json'));
ok('含 education 域', !!byDomain.education);
ok('角色总数 >= 40', Object.values(byDomain).reduce((s, a) => s + a.length, 0) >= 40);

console.log(`\n==== 结果：${pass} 通过 / ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
