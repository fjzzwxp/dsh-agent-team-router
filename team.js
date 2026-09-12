'use strict';
/*
 * team.js — Agent Team Router 团队状态机 v2
 * 职责：把 roster（角色编制）物化为一支可执行团队，管理成员、任务、阶段依赖（DAG）、
 *       派工、完成、多 Agent 协作（handoff/inbox）、关键路径与并行度分析、5 阶段质量门禁、汇总。
 * 数据以 JSON 文件落盘，跨平台可用。
 *
 * 存储：<workspace>/team.json（团队全量状态）
 * 依赖图（DAG）：分层结构 —— 某阶段的任务依赖「紧邻的前一阶段」全部任务（层内任务彼此独立、可并行）。
 * 协作协议（AgentTeams）：任务完成时自动把制品投递到下游依赖任务的 inbox；派工时把上游 inbox 作为上下文注入。
 */

const fs = require('fs');
const path = require('path');

// v2：五阶段流程
const PHASES = ['discovery', 'analysis', 'design', 'creation', 'assurance'];
const PHASE_LABEL = { discovery: '调研', analysis: '分析', design: '设计', creation: '产出', assurance: '审查' };

function nowISO() { return new Date().toISOString(); }

class TeamStore {
  constructor(workspace) {
    this.workspace = workspace;
    this.teamFile = path.join(workspace, 'team.json');
    fs.mkdirSync(workspace, { recursive: true });
  }

  _save(team) {
    fs.writeFileSync(this.teamFile, JSON.stringify(team, null, 2), 'utf8');
  }

  _load() {
    if (!fs.existsSync(this.teamFile)) throw new Error(`团队不存在：${this.teamFile}，请先 assemble`);
    return JSON.parse(fs.readFileSync(this.teamFile, 'utf8'));
  }

  /** 由 roster 物化团队：展开成员、生成分层 DAG（任务依赖紧邻前序阶段）、初始化 inbox */
  create(roster) {
    const members = [];
    const tasks = [];
    let m = 0, t = 0;
    const phaseTasks = {}; // 记录每个阶段已生成的 taskId，用于构建依赖边
    for (const r of roster.roles) {
      const memberIds = [];
      for (let i = 0; i < r.count; i++) {
        const mid = `m${++m}`;
        members.push({
          memberId: mid, role: r.name, slot: r.slot, phase: r.phase,
          name: `${r.name} #${i + 1}`, status: 'idle',
        });
        memberIds.push(mid);
      }
      // 依赖：紧邻的前一阶段全部任务（分层 DAG，去掉跨多阶段的冗余边）
      const prevPhase = PHASES[PHASES.indexOf(r.phase) - 1];
      const dependsOn = prevPhase && phaseTasks[prevPhase] ? [...phaseTasks[prevPhase]] : [];
      const tid = `t${++t}`;
      tasks.push({
        taskId: tid, slot: r.slot, name: r.name, phase: r.phase, phaseLabel: r.phaseLabel,
        priority: r.priority, count: r.count, dependsOn, members: memberIds,
        status: 'pending', duty: r.duty, acceptance: r.acceptance,
        handoffTo: r.handoffTo, attempts: [], artifact: null, inbox: [], context: '',
      });
      (phaseTasks[r.phase] = phaseTasks[r.phase] || []).push(tid);
    }
    const team = {
      teamId: `team_${Date.now()}`,
      createdAt: nowISO(),
      task: roster.task || '',
      phases: PHASES,
      roles: roster.roles,
      members, tasks, artifacts: {},
    };
    this._save(team);
    return team;
  }

  /** 可被派工的任务（依赖已全部完成，且自身未完成） */
  readyTasks() {
    const team = this._load();
    const done = new Set(team.tasks.filter((t) => t.status === 'completed' || t.status === 'rework').map((t) => t.taskId));
    return team.tasks.filter((t) => t.status !== 'completed' && t.dependsOn.every((d) => done.has(d)));
  }

  /** 派工：把某个成员指派到某任务（开始一次尝试）；自动注入上游 inbox 作为上下文 */
  dispatch(taskId, memberId) {
    const team = this._load();
    const task = team.tasks.find((t) => t.taskId === taskId);
    const member = team.members.find((m) => m.memberId === memberId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (!member) throw new Error(`成员不存在：${memberId}`);
    if (!task.members.includes(memberId)) throw new Error(`成员 ${memberId} 不属于任务 ${taskId}`);
    member.status = 'busy';
    // 协作协议：把上游投递到本任务的制品聚合为上下文
    const ctx = task.inbox
      .filter((m) => m.artifact)
      .map((m) => `【上游 ${m.from} 交付】\n${m.artifact}`)
      .join('\n\n');
    task.context = ctx;
    task.attempts.push({ memberId, startedAt: nowISO(), status: 'in_progress', context: ctx });
    task.status = task.status === 'pending' ? 'in_progress' : task.status;
    this._save(team);
    return task;
  }

  /** 完成任务：记录产出；全部成员完成后置 completed 并沉淀制品，随后向下游投递（协作协议） */
  complete(taskId, memberId, output) {
    const team = this._load();
    const task = team.tasks.find((t) => t.taskId === taskId);
    const member = team.members.find((m) => m.memberId === memberId);
    if (!task || !member) throw new Error('任务或成员不存在');
    const att = task.attempts.find((a) => a.memberId === memberId && a.status === 'in_progress');
    if (att) { att.status = 'done'; att.completedAt = nowISO(); att.output = output || ''; }
    else { task.attempts.push({ memberId, startedAt: nowISO(), completedAt: nowISO(), status: 'done', output: output || '' }); }
    member.status = 'done';
    const allDone = task.members.every((mid) => {
      const mm = team.members.find((x) => x.memberId === mid);
      return mm.status === 'done';
    });
    if (allDone) {
      task.status = 'completed';
      task.artifact = task.attempts.filter((a) => a.status === 'done').map((a) => a.output).join('\n\n---\n\n');
      team.artifacts[task.taskId] = task.artifact;
      this._deliver(team, task); // 协作协议：向下游投递
    }
    this._save(team);
    return { task, allDone };
  }

  /** 协作协议核心：把任务制品投递到所有下游依赖任务（dependsOn 包含本任务）的 inbox */
  _deliver(team, task) {
    for (const dt of team.tasks) {
      if (dt.dependsOn.includes(task.taskId)) {
        dt.inbox.push({
          from: task.name, fromTask: task.taskId, at: nowISO(),
          artifact: task.artifact, note: '阶段交付自动投递',
        });
      }
    }
  }

  /** 显式 handoff：手动把本任务制品 + 备注投递给指定下游任务（协作协议） */
  handoff(taskId, toTaskId, note) {
    const team = this._load();
    const task = team.tasks.find((t) => t.taskId === taskId);
    const to = team.tasks.find((t) => t.taskId === toTaskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (!to) throw new Error(`目标任务不存在：${toTaskId}`);
    if (!to.dependsOn.includes(taskId)) {
      // 非直接下游也允许投递（跨阶段协作），但提示
      console.warn(`⚠️ ${toTaskId} 非 ${taskId} 的直接下游，仍投递（跨阶段协作）`);
    }
    if (!task.artifact) throw new Error(`任务 ${taskId} 尚无制品，无法投递`);
    to.inbox.push({
      from: task.name, fromTask: taskId, at: nowISO(),
      artifact: task.artifact, note: note || '手动 handoff',
    });
    this._save(team);
    return to;
  }

  /** 任意任务间发送协作消息（不携带制品） */
  sendMessage(fromTaskId, toTaskId, note) {
    const team = this._load();
    const to = team.tasks.find((t) => t.taskId === toTaskId);
    if (!to) throw new Error(`目标任务不存在：${toTaskId}`);
    to.inbox.push({ from: fromTaskId, fromTask: fromTaskId, at: nowISO(), artifact: null, note: note || '' });
    this._save(team);
    return to;
  }

  /** 读取某任务的 inbox（协作上下文） */
  inboxOf(taskId) {
    const team = this._load();
    const task = team.tasks.find((t) => t.taskId === taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    return task.inbox;
  }

  /** 质量审查（assurance 阶段）：必须有 verdict 与 findings */
  review(taskId, verdict, findings, reviewerMemberId) {
    const team = this._load();
    const task = team.tasks.find((t) => t.taskId === taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (!['pass', 'reject'].includes(verdict)) throw new Error('verdict 必须为 pass 或 reject');
    const att = {
      memberId: reviewerMemberId || 'reviewer',
      startedAt: nowISO(), completedAt: nowISO(), status: 'review',
      verdict, findings: findings || '',
    };
    task.attempts.push(att);
    task.verdict = verdict;
    task.findings = findings || '';
    task.status = verdict === 'pass' ? 'completed' : 'rework';
    this._save(team);
    return task;
  }

  /** 状态快照 */
  status() {
    const team = this._load();
    const progress = team.tasks.map((t) => ({
      taskId: t.taskId, name: t.name, phase: t.phaseLabel, status: t.status,
      membersDone: t.members.filter((mid) => {
        const m = team.members.find((x) => x.memberId === mid);
        return m && m.status === 'done';
      }).length,
      count: t.count, dependencies: t.dependsOn,
    }));
    return {
      teamId: team.teamId, task: team.task,
      members: team.members.length, tasks: team.tasks.length,
      completed: team.tasks.filter((t) => t.status === 'completed').length,
      progress,
    };
  }

  /** 构建 DAG（节点/边/分层/拓扑序） */
  buildDag() {
    const team = this._load();
    const layers = {};
    for (const t of team.tasks) (layers[t.phase] = layers[t.phase] || []).push(t.taskId);
    const edges = [];
    for (const t of team.tasks) for (const d of t.dependsOn) edges.push([d, t.taskId]);
    const topo = [];
    for (const ph of PHASES) if (layers[ph]) for (const id of layers[ph]) topo.push(id);
    // 环检测（分层 DAG 理论上无环，仍校验）
    const indeg = {};
    for (const id of topo) indeg[id] = 0;
    for (const [, to] of edges) indeg[to] = (indeg[to] || 0) + 1;
    const queue = topo.filter((id) => indeg[id] === 0);
    let visited = 0;
    const q = [...queue];
    while (q.length) {
      const n = q.shift(); visited++;
      for (const [from, to] of edges) if (from === n) { indeg[to]--; if (indeg[to] === 0) q.push(to); }
    }
    const hasCycle = visited !== topo.length;
    return { layers, edges, topo, hasCycle };
  }

  /** 关键路径与并行度分析（分层 DAG 模型） */
  analyze() {
    const team = this._load();
    const dag = this.buildDag();
    const presentPhases = PHASES.filter((p) => dag.layers[p]);
    const makespan = presentPhases.length; // 层内并行、层间串行 → 最短工期 = 层数
    const total = team.tasks.length;
    const layerSizes = presentPhases.map((p) => dag.layers[p].length);
    const maxParallel = Math.max(...layerSizes, 0);
    const avgParallel = total / makespan;
    const speedup = total / makespan; // 相对“全串行”的加速比
    const parallelizable = total - presentPhases.length; // 超出每层级联主路径的并行/副本任务数
    const criticalPath = presentPhases.map((p) => ({ phase: p, label: PHASE_LABEL[p], tasks: dag.layers[p].length }));
    // 简易排程：ES=层序, EF=ES+1
    const schedule = {};
    presentPhases.forEach((p, i) => { for (const id of dag.layers[p]) schedule[id] = { es: i, ef: i + 1 }; });
    return {
      makespan, total, maxParallel, avgParallel: Number(avgParallel.toFixed(2)),
      speedup: Number(speedup.toFixed(2)), parallelizable, criticalPath, layerSizes,
      hasCycle: dag.hasCycle, schedule,
    };
  }

  /** 5 阶段质量门禁：逐阶段出口校验 + assurance 最终判决 */
  qualityGate() {
    const team = this._load();
    const stages = [];
    let overall = true;
    const blockers = [];
    for (const ph of PHASES) {
      const ts = team.tasks.filter((t) => t.phase === ph);
      if (!ts.length) continue;
      const total = ts.length;
      const done = ts.filter((t) => t.status === 'completed').length;
      let passed = done;
      let gate = 'open';
      if (ph === 'assurance') {
        passed = ts.filter((t) => t.verdict === 'pass').length;
        const rejected = ts.filter((t) => t.verdict === 'reject').length;
        if (rejected > 0) { gate = 'blocked'; overall = false; }
        else if (done === total && passed === total) gate = 'passed';
        else { gate = 'in_progress'; overall = false; }
      } else {
        if (done === total) gate = 'passed';
        else { gate = 'in_progress'; overall = false; }
      }
      if (gate === 'blocked') {
        for (const t of ts.filter((x) => x.verdict === 'reject')) {
          blockers.push({ taskId: t.taskId, name: t.name, reason: `审查被拒（verdict=reject）：${t.findings || '未说明'}` });
        }
      }
      stages.push({ phase: ph, label: PHASE_LABEL[ph], total, done, passed, gate });
    }
    // 阶段顺序门禁：若前序阶段未 passed，则后续阶段即便完成也不算整体可交付
    let prevPassed = true;
    for (const s of stages) {
      if (!prevPassed && s.gate === 'passed') {
        // 前序未过，强制降级为 blocked（顺序被破坏）
        s.gate = 'blocked';
        overall = false;
        blockers.push({ taskId: `-`, name: `${s.label}阶段`, reason: `前序阶段未完成，阶段顺序门禁未通过` });
      }
      prevPassed = s.gate === 'passed';
    }
    return { stages, overall, blockers, ok: overall && !blockers.length };
  }

  /** 汇总：按阶段聚合制品 + 5 阶段质量门禁 */
  merge() {
    const team = this._load();
    const gate = this.qualityGate();
    const labelOf = (p) => PHASE_LABEL[p];
    const sections = [];
    for (const ph of PHASES) {
      const ts = team.tasks.filter((t) => t.phase === ph && t.artifact);
      if (!ts.length) continue;
      sections.push(`## ${labelOf(ph)}阶段\n`);
      for (const t of ts) sections.push(`### ${t.name}（${t.taskId}）\n${t.artifact}\n`);
    }
    const reviewNotes = team.tasks
      .filter((t) => t.phase === 'assurance' && t.findings)
      .map((t) => `- ${t.name}（${t.verdict}）：${t.findings}`);
    const gateLines = gate.stages.map((s) =>
      `- ${s.label}阶段：完成 ${s.done}/${s.total} ｜ 门禁 **${s.gate}**`);
    const report = [
      `# 团队协作交付报告`,
      `> 任务：${team.task}`,
      `> 团队：${team.teamId} ｜ 成员 ${team.members.length} 人 ｜ 任务 ${team.tasks.length} 项`,
      '',
      ...sections,
      reviewNotes.length ? `## 审查意见\n${reviewNotes.join('\n')}` : '',
      `## 质量门禁（5 阶段）`,
      ...gateLines,
      gate.blockers.length
        ? `## ⚠️ 待裁决阻断项\n${gate.blockers.map((b) => `- ${b.taskId} ${b.name}：${b.reason}`).join('\n')}`
        : `## ✅ 质量门禁：全部通过`,
    ].filter(Boolean).join('\n');

    return { report, blockers: gate.blockers, ok: gate.ok, gate };
  }
}

// ----------------- CLI -----------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const getOpt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const ws = getOpt('--workspace') || '.';

  try {
    const store = new TeamStore(ws);
    if (cmd === 'assemble') {
      const rosterPath = getOpt('--roster') || 'roster.json';
      const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
      const team = store.create(roster);
      console.log(`✓ 建队完成：${team.teamId} ｜ 成员 ${team.members.length} ｜ 任务 ${team.tasks.length}`);
      for (const t of team.tasks) console.log(`  ${t.taskId} [${t.priority}] ${t.phaseLabel} ${t.name} ×${t.count} 依赖[${t.dependsOn.join(',') || '-'}]`);
    } else if (cmd === 'status') {
      console.log(JSON.stringify(store.status(), null, 2));
    } else if (cmd === 'ready') {
      console.log(JSON.stringify(store.readyTasks().map((t) => ({ taskId: t.taskId, name: t.name, phase: t.phaseLabel, deps: t.dependsOn })), null, 2));
    } else if (cmd === 'dispatch') {
      const t = store.dispatch(getOpt('--task'), getOpt('--member'));
      console.log(`✓ 派工 ${getOpt('--task')} → ${getOpt('--member')}（${t.status}）｜ 注入上游上下文 ${t.context ? '是' : '否'}`);
    } else if (cmd === 'complete') {
      const r = store.complete(getOpt('--task'), getOpt('--member'), getOpt('--output') || '');
      console.log(`✓ 完成 ${getOpt('--task')} / ${getOpt('--member')} ｜ 任务全部完成：${r.allDone}${r.allDone ? '（已向下游投递）' : ''}`);
    } else if (cmd === 'handoff') {
      const t = store.handoff(getOpt('--task'), getOpt('--to'), getOpt('--note') || '');
      console.log(`✓ handoff ${getOpt('--task')} → ${getOpt('--to')}（已投递到 inbox）`);
    } else if (cmd === 'inbox') {
      console.log(JSON.stringify(store.inboxOf(getOpt('--task')), null, 2));
    } else if (cmd === 'send') {
      store.sendMessage(getOpt('--from'), getOpt('--to'), getOpt('--note') || '');
      console.log(`✓ 消息已发送至 ${getOpt('--to')} 的 inbox`);
    } else if (cmd === 'review') {
      const t = store.review(getOpt('--task'), getOpt('--verdict'), getOpt('--findings') || '', getOpt('--member'));
      console.log(`✓ 审查 ${getOpt('--task')} → verdict=${t.verdict}`);
    } else if (cmd === 'analyze') {
      console.log(JSON.stringify(store.analyze(), null, 2));
    } else if (cmd === 'gate') {
      console.log(JSON.stringify(store.qualityGate(), null, 2));
    } else if (cmd === 'merge') {
      const { report, blockers, ok } = store.merge();
      const out = getOpt('--out') || 'report.md';
      fs.writeFileSync(out, report, 'utf8');
      console.log(`✓ 汇总已写入 ${out} ｜ 阻断项 ${blockers.length} ｜ ok=${ok}`);
      process.exitCode = ok ? 0 : 2;
    } else {
      console.error('用法: node team.js <assemble|status|ready|dispatch|complete|handoff|inbox|send|review|analyze|gate|merge> --workspace <ws> [选项]');
      process.exit(1);
    }
  } catch (e) {
    console.error('✗', e.message);
    process.exit(1);
  }
}

module.exports = { TeamStore, PHASES, PHASE_LABEL, buildDag: (s) => s.buildDag(), analyze: (s) => s.analyze() };
