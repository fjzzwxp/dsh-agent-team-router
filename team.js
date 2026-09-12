'use strict';
/*
 * team.js — Agent Team Router 团队状态机
 * 职责：把 roster（角色编制）物化为一支可执行团队，管理成员、任务、阶段依赖、
 *       派工、完成、质量审查与最终汇总。数据以 JSON 文件落盘，跨平台可用。
 *
 * 存储：<workspace>/team.json（团队全量状态）
 * 任务依赖：pipeline 语义 —— 某阶段的任务依赖所有更早阶段的任务完成后才可执行。
 */

const fs = require('fs');
const path = require('path');

const PHASES = ['discovery', 'analysis', 'creation', 'assurance'];

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

  /** 由 roster 物化团队：展开成员、生成带阶段依赖的任务图 */
  create(roster) {
    const members = [];
    const tasks = [];
    let m = 0, t = 0;
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
      const dependsOn = tasks
        .filter((x) => PHASES.indexOf(x.phase) < PHASES.indexOf(r.phase))
        .map((x) => x.taskId);
      const tid = `t${++t}`;
      tasks.push({
        taskId: tid, slot: r.slot, name: r.name, phase: r.phase, phaseLabel: r.phaseLabel,
        priority: r.priority, count: r.count, dependsOn, members: memberIds,
        status: 'pending', duty: r.duty, acceptance: r.acceptance,
        handoffTo: r.handoffTo, attempts: [], artifact: null,
      });
    }
    const team = {
      teamId: `team_${Date.now()}`,
      createdAt: nowISO(),
      task: roster.task || '',
      roles: roster.roles,
      members, tasks, artifacts: {},
    };
    this._save(team);
    return team;
  }

  /** 可被派工的任务（依赖已全部完成，且自身未完成） */
  readyTasks() {
    const team = this._load();
    const done = new Set(team.tasks.filter((t) => t.status === 'completed').map((t) => t.taskId));
    return team.tasks.filter((t) => t.status !== 'completed' && t.dependsOn.every((d) => done.has(d)));
  }

  /** 派工：把某个成员指派到某任务（开始一次尝试） */
  dispatch(taskId, memberId) {
    const team = this._load();
    const task = team.tasks.find((t) => t.taskId === taskId);
    const member = team.members.find((m) => m.memberId === memberId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (!member) throw new Error(`成员不存在：${memberId}`);
    if (!task.members.includes(memberId)) throw new Error(`成员 ${memberId} 不属于任务 ${taskId}`);
    member.status = 'busy';
    task.attempts.push({ memberId, startedAt: nowISO(), status: 'in_progress' });
    task.status = task.status === 'pending' ? 'in_progress' : task.status;
    this._save(team);
    return task;
  }

  /** 完成任务：记录一次尝试产出；某任务全部成员完成后置为 completed 并沉淀制品 */
  complete(taskId, memberId, output) {
    const team = this._load();
    const task = team.tasks.find((t) => t.taskId === taskId);
    const member = team.members.find((m) => m.memberId === memberId);
    if (!task || !member) throw new Error('任务或成员不存在');
    const att = task.attempts.find((a) => a.memberId === memberId && a.status === 'in_progress');
    if (att) { att.status = 'done'; att.completedAt = nowISO(); att.output = output || ''; }
    member.status = 'done';
    const allDone = task.members.every((mid) => {
      const m = team.members.find((x) => x.memberId === mid);
      return m.status === 'done';
    });
    if (allDone) {
      task.status = 'completed';
      task.artifact = task.attempts.filter((a) => a.status === 'done').map((a) => a.output).join('\n\n---\n\n');
      team.artifacts[task.taskId] = task.artifact;
    }
    this._save(team);
    return { task, allDone };
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
      count: t.count,
    }));
    return {
      teamId: team.teamId, task: team.task,
      members: team.members.length, tasks: team.tasks.length,
      completed: team.tasks.filter((t) => t.status === 'completed').length,
      progress,
    };
  }

  /** 汇总：按阶段聚合制品，并做质量门禁校验 */
  merge() {
    const team = this._load();
    const blockers = [];
    for (const t of team.tasks) {
      if (t.phase === 'creation' && t.status !== 'completed') {
        blockers.push({ taskId: t.taskId, name: t.name, reason: '产出阶段任务未完成，缺少交付物' });
      }
      if (t.phase === 'assurance' && t.verdict !== 'pass') {
        blockers.push({ taskId: t.taskId, name: t.name, reason: `审查未通过（verdict=${t.verdict || '未审查'}）` });
      }
    }
    const sections = [];
    for (const ph of PHASES) {
      const ts = team.tasks.filter((t) => t.phase === ph && t.artifact);
      if (!ts.length) continue;
      sections.push(`## ${ph === 'discovery' ? '调研' : ph === 'analysis' ? '分析' : ph === 'creation' ? '产出' : '审查'}阶段\n`);
      for (const t of ts) {
        sections.push(`### ${t.name}（${t.taskId}）\n${t.artifact}\n`);
      }
    }
    const reviewNotes = team.tasks
      .filter((t) => t.phase === 'assurance' && t.findings)
      .map((t) => `- ${t.name}（${t.verdict}）：${t.findings}`);
    const report = [
      `# 团队协作交付报告`,
      `> 任务：${team.task}`,
      `> 团队：${team.teamId} ｜ 成员 ${team.members.length} 人 ｜ 任务 ${team.tasks.length} 项`,
      '',
      ...sections,
      reviewNotes.length ? `## 审查意见\n${reviewNotes.join('\n')}` : '',
      blockers.length ? `## ⚠️ 待裁决阻断项\n${blockers.map((b) => `- ${b.taskId} ${b.name}：${b.reason}`).join('\n')}` : '## ✅ 质量门禁：全部通过',
    ].filter(Boolean).join('\n');

    return { report, blockers, ok: blockers.length === 0 };
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
      console.log(JSON.stringify(store.readyTasks().map((t) => ({ taskId: t.taskId, name: t.name, phase: t.phaseLabel })), null, 2));
    } else if (cmd === 'dispatch') {
      const t = store.dispatch(getOpt('--task'), getOpt('--member'));
      console.log(`✓ 派工 ${getOpt('--task')} → ${getOpt('--member')}（${t.status}）`);
    } else if (cmd === 'complete') {
      const r = store.complete(getOpt('--task'), getOpt('--member'), getOpt('--output') || '');
      console.log(`✓ 完成 ${getOpt('--task')} / ${getOpt('--member')} ｜ 任务全部完成：${r.allDone}`);
    } else if (cmd === 'review') {
      const t = store.review(getOpt('--task'), getOpt('--verdict'), getOpt('--findings') || '', getOpt('--member'));
      console.log(`✓ 审查 ${getOpt('--task')} → verdict=${t.verdict}`);
    } else if (cmd === 'merge') {
      const { report, blockers, ok } = store.merge();
      const out = getOpt('--out') || 'report.md';
      fs.writeFileSync(out, report, 'utf8');
      console.log(`✓ 汇总已写入 ${out} ｜ 阻断项 ${blockers.length} ｜ ok=${ok}`);
      process.exitCode = ok ? 0 : 2;
    } else {
      console.error('用法: node team.js <assemble|status|ready|dispatch|complete|review|merge> --workspace <ws> [选项]');
      process.exit(1);
    }
  } catch (e) {
    console.error('✗', e.message);
    process.exit(1);
  }
}

module.exports = { TeamStore, PHASES };
