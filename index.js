'use strict';
/*
 * index.js — DSH (DeepSeek Harness) / Cordis 4 插件入口
 * 导出契约：name / inject / Config / apply(ctx, config)
 * 通过 ctx.tools.register(defineTool({...})) 注册团队路由与调度工具。
 *
 * v2 新增能力：DAG 关键路径/并行度分析、多 Agent 协作（handoff/inbox）、5 阶段质量门禁。
 *
 * 安装：dsh plugin --profile web add <本目录或 npm 包>
 * 加载：cordis.patch.yml 将本插件注入 DSH 运行时。
 */

const fs = require('fs');
const path = require('path');
const { routeTask, catalog } = require('./router');
const { TeamStore } = require('./team');
const { resolveWorkspace, resolveArtifactPath } = require('./paths');

const { defineTool } = require('@deepseek-ai/dsh-tools');

exports.name = 'agent-team-router';
exports.inject = ['tools'];

// Cordis 插件配置（同时作为默认值，避免使用 schemastery API 带来的运行时风险）
exports.Config = {
  rolesPath: '',                       // 可选：自定义角色库 JSON 路径
  defaultWorkspace: './.agent-team',   // 团队状态默认存储目录
};

function resolveRolesPath(config) {
  const p = (config && config.rolesPath) || '';
  return p || path.join(__dirname, 'roles.json');
}

function summarizeRoster(roster) {
  const lines = roster.roles.map(
    (r) => `- ${r.slot} [${r.priority}] ${r.phaseLabel} **${r.name}** ×${r.count} (${r.confidence})${r.matchedTerms.length ? ' · 命中:' + r.matchedTerms.join('/') : ''}`
  );
  return `### 路由结果（${roster.roles.length} 个角色）\n${lines.join('\n')}`;
}

function registerTools(ctx, config) {
  const tools = [
    {
      name: 'team_router_route',
      description: '将一段任务文本路由为合适的多角色团队编制（roster）。按五阶段（调研/分析/设计/产出/审查）分配角色，' +
        '支持 --include 手动补位与 --exclude 排除。返回角色清单（每阶段 Top-K 候选，避免编制膨胀）。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '任务描述文本' },
          include: { type: 'string', description: '可选，手动指定角色，形如 "Course Designer:creation;Training Facilitator:creation"，分号分隔' },
          exclude: { type: 'string', description: '可选，排除角色名，逗号分隔' },
          topK: { type: 'number', description: '可选，每阶段最多保留候选数，默认 3' },
          workspace: { type: 'string', description: '可选，团队/产物工作空间目录；roster.json 将写入此目录（相对路径解析为绝对路径，避免污染进程 CWD），默认 ./agent-team' },
          out: { type: 'string', description: '可选，roster 输出路径，默认落到工作空间内的 roster.json（绝对路径则原样尊重）' },
        },
        required: ['task'],
      },
      output: { schema: { type: 'object' }, render: (o) => o.markdown },
      execute: async (args) => {
        const include = (args.include || '').split(';').map((s) => s.trim()).filter(Boolean);
        const exclude = (args.exclude || '').split(',').map((s) => s.trim()).filter(Boolean);
        const roster = routeTask(args.task, { include, exclude, rolesPath: resolveRolesPath(config), topK: args.topK });
        const ws = resolveWorkspace(args.workspace || (config && config.defaultWorkspace));
        fs.mkdirSync(ws, { recursive: true });
        const out = resolveArtifactPath(ws, args.out, 'roster.json');
        fs.writeFileSync(out, JSON.stringify(roster, null, 2), 'utf8');
        return { markdown: `${summarizeRoster(roster)}\n\n> roster 已写入 \`${out}\``, roster };
      },
    },
    {
      name: 'team_router_catalog',
      description: '列出内置角色库全量目录（按域分组，共 297 角色，含 agency-agents 273 专业角色与精选中文域角色），用于了解可路由角色及 --include 可填的真实角色名。',
      parameters: { type: 'object', properties: {}, required: [] },
      output: { schema: { type: 'object' }, render: (o) => o.markdown },
      execute: async () => {
        const byDomain = catalog(resolveRolesPath(config));
        const lines = [];
        for (const d of Object.keys(byDomain)) {
          lines.push(`**${d}** (${byDomain[d].length})`);
          for (const r of byDomain[d]) lines.push(`- ${r.name} [${r.phases.join('/')}] : ${r.duty}`);
        }
        return { markdown: `### 角色库目录（${Object.values(byDomain).reduce((a, x) => a + x.length, 0)} 角色）\n${lines.join('\n')}` };
      },
    },
    {
      name: 'team_router_assemble',
      description: '将 roster.json 物化为一支可执行团队：展开成员、生成分层 DAG（任务依赖紧邻前序阶段，层内并行）。返回任务图。',
      parameters: {
        type: 'object',
        properties: {
          rosterPath: { type: 'string', description: 'roster.json 路径' },
          workspace: { type: 'string', description: '团队状态存储目录' },
        },
        required: ['rosterPath'],
      },
      output: { schema: { type: 'object' }, render: (o) => o.markdown },
      execute: async (args) => {
        const ws = resolveWorkspace(args.workspace || (config && config.defaultWorkspace));
        const rosterPath = args.rosterPath
          ? (path.isAbsolute(args.rosterPath) ? args.rosterPath : path.resolve(ws, args.rosterPath))
          : path.join(ws, 'roster.json');
        const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
        const store = new TeamStore(ws);
        const team = store.create(roster);
        const lines = team.tasks.map((t) => `- ${t.taskId} [${t.priority}] ${t.phaseLabel} ${t.name} ×${t.count} 依赖[${t.dependsOn.join(',') || '-'}]`);
        return { markdown: `✓ 建队 ${team.teamId} ｜ 成员 ${team.members.length} ｜ 任务 ${team.tasks.length}（分层 DAG）\n${lines.join('\n')}\n\n> 工作区: \`${ws}\``, team };
      },
    },
    {
      name: 'team_router_status',
      description: '查看团队当前状态：各任务进度、成员完成情况与依赖。',
      parameters: {
        type: 'object',
        properties: { workspace: { type: 'string', description: '团队状态存储目录' } },
        required: ['workspace'],
      },
      output: { schema: { type: 'object' }, render: (o) => o.markdown },
      execute: async (args) => {
        const store = new TeamStore(args.workspace);
        const s = store.status();
        const lines = s.progress.map((p) => `- ${p.taskId} ${p.phase} ${p.name} : ${p.status} (${p.membersDone}/${p.count}) 依赖[${p.dependencies.join(',') || '-'}]`);
        return { markdown: `团队 ${s.teamId}\n已完成 ${s.completed}/${s.tasks} 任务\n${lines.join('\n')}`, status: s };
      },
    },
    {
      name: 'team_router_ready',
      description: '列出当前可被派工的任务（依赖已全部完成）。',
      parameters: {
        type: 'object',
        properties: { workspace: { type: 'string', description: '团队状态存储目录' } },
        required: ['workspace'],
      },
      output: { schema: { type: 'object' }, render: (o) => o.markdown },
      execute: async (args) => {
        const store = new TeamStore(args.workspace);
        const ready = store.readyTasks();
        const lines = ready.map((t) => `- ${t.taskId} ${t.phaseLabel} ${t.name} (成员 ${t.members.join(',')})`);
        return { markdown: `可派工任务 ${ready.length} 项：\n${lines.join('\n') || '（无）'}`, ready };
      },
    },
    {
      name: 'team_router_dispatch',
      description: '把某成员指派到某任务（开始一次执行尝试）。派工时自动把上游投递到该任务 inbox 的制品作为上下文注入。',
      parameters: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: '团队状态存储目录' },
          task: { type: 'string', description: '任务 ID，如 t1' },
          member: { type: 'string', description: '成员 ID，如 m1' },
        },
        required: ['workspace', 'task', 'member'],
      },
      output: { schema: { type: 'object' }, render: (o) => o.markdown },
      execute: async (args) => {
        const store = new TeamStore(args.workspace);
        const t = store.dispatch(args.task, args.member);
        return { markdown: `✓ 派工 ${args.task} → ${args.member}${t.context ? '（已注入上游上下文）' : ''}` };
      },
    },
    {
      name: 'team_router_complete',
      description: '标记某成员完成其任务尝试，并附上交付产出。当任务全部成员完成，沉淀为阶段制品，并自动向下游依赖任务投递（协作协议）。',
      parameters: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: '团队状态存储目录' },
          task: { type: 'string', description: '任务 ID' },
          member: { type: 'string', description: '成员 ID' },
          output: { type: 'string', description: '交付产出文本' },
        },
        required: ['workspace', 'task', 'member'],
      },
      output: { schema: { type: 'object' }, render: (o) => o.markdown },
      execute: async (args) => {
        const store = new TeamStore(args.workspace);
        const r = store.complete(args.task, args.member, args.output || '');
        return { markdown: `✓ 完成 ${args.task} / ${args.member} ｜ 任务全部完成：${r.allDone}${r.allDone ? '（已自动向下游投递制品）' : ''}` };
      },
    },
    {
      name: 'team_router_handoff',
      description: '多 Agent 协作协议：将某已完成任务的制品 + 备注手动投递给指定下游任务（写入其 inbox），实现 Agent 间上下文交接。',
      parameters: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: '团队状态存储目录' },
          task: { type: 'string', description: '源任务 ID（需已有制品）' },
          to: { type: 'string', description: '目标任务 ID（下游）' },
          note: { type: 'string', description: '可选，交接备注' },
        },
        required: ['workspace', 'task', 'to'],
      },
      output: { schema: { type: 'object' }, render: (o) => o.markdown },
      execute: async (args) => {
        const store = new TeamStore(args.workspace);
        store.handoff(args.task, args.to, args.note);
        return { markdown: `✓ handoff ${args.task} → ${args.to}（已投递到目标 inbox）` };
      },
    },
    {
      name: 'team_router_inbox',
      description: '读取某任务的 inbox（来自上游 Agent 的协作上下文与制品投递），用于了解本任务可消费的依赖产出。',
      parameters: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: '团队状态存储目录' },
          task: { type: 'string', description: '任务 ID' },
        },
        required: ['workspace', 'task'],
      },
      output: { schema: { type: 'object' }, render: (o) => o.markdown },
      execute: async (args) => {
        const store = new TeamStore(args.workspace);
        const inbox = store.inboxOf(args.task);
        const lines = inbox.map((m) => `- 来自 ${m.from}：${m.note || ''}${m.artifact ? '（含制品）' : '（仅消息）'}`);
        return { markdown: `任务 ${args.task} 的 inbox（${inbox.length} 条）：\n${lines.join('\n') || '（空）'}`, inbox };
      },
    },
    {
      name: 'team_router_review',
      description: '质量审查（审查阶段任务）：必须给出 verdict(pass/reject) 与 findings。',
      parameters: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: '团队状态存储目录' },
          task: { type: 'string', description: '审查任务 ID' },
          verdict: { type: 'string', description: 'pass 或 reject' },
          findings: { type: 'string', description: '审查意见' },
          member: { type: 'string', description: '可选，审查成员 ID' },
        },
        required: ['workspace', 'task', 'verdict'],
      },
      output: { schema: { type: 'object' }, render: (o) => o.markdown },
      execute: async (args) => {
        const store = new TeamStore(args.workspace);
        store.review(args.task, args.verdict, args.findings || '', args.member);
        return { markdown: `✓ 审查 ${args.task} → verdict=${args.verdict}` };
      },
    },
    {
      name: 'team_router_analyze',
      description: 'DAG 分析：计算关键路径、最短工期（makespan）、最大并行度、平均并行度、相对全串行的加速比、可并行任务数，以及简易排程（ES/EF）。',
      parameters: {
        type: 'object',
        properties: { workspace: { type: 'string', description: '团队状态存储目录' } },
        required: ['workspace'],
      },
      output: { schema: { type: 'object' }, render: (o) => o.markdown },
      execute: async (args) => {
        const store = new TeamStore(args.workspace);
        const a = store.analyze();
        const cp = a.criticalPath.map((c) => `${c.label}(${c.tasks})`).join(' → ');
        const lines = [
          `- 关键路径（阶段 spine）：${cp}`,
          `- 最短工期 makespan：${a.makespan} 个阶段`,
          `- 任务总数：${a.total} ｜ 最大并行度：${a.maxParallel} ｜ 平均并行度：${a.avgParallel}`,
          `- 相对全串行加速比：${a.speedup}× ｜ 可并行任务数：${a.parallelizable}`,
          a.hasCycle ? `- ⚠️ 检测到环！` : `- DAG 无环：✓`,
        ];
        return { markdown: `### DAG 并行分析\n${lines.join('\n')}`, analyze: a };
      },
    },
    {
      name: 'team_router_gates',
      description: '5 阶段质量门禁：逐阶段（调研/分析/设计/产出/审查）出口校验，并强制阶段顺序门禁（前序未过则后续不交付）。返回各阶段门禁状态与阻断项。',
      parameters: {
        type: 'object',
        properties: { workspace: { type: 'string', description: '团队状态存储目录' } },
        required: ['workspace'],
      },
      output: { schema: { type: 'object' }, render: (o) => o.markdown },
      execute: async (args) => {
        const store = new TeamStore(args.workspace);
        const g = store.qualityGate();
        const lines = g.stages.map((s) => `- ${s.label}阶段：完成 ${s.done}/${s.total} ｜ 门禁 **${s.gate}**`);
        if (g.blockers.length) lines.push(`\n⚠️ 阻断项：\n` + g.blockers.map((b) => `  - ${b.taskId} ${b.name}：${b.reason}`).join('\n'));
        else lines.push(`\n✅ 整体门禁：通过`);
        return { markdown: `### 质量门禁（5 阶段）\n${lines.join('\n')}`, gate: g };
      },
    },
    {
      name: 'team_router_merge',
      description: '汇总所有阶段制品生成交付报告，并执行 5 阶段质量门禁（各阶段需完成、审查需 pass、阶段顺序需闭合）。返回报告与阻断项。',
      parameters: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: '团队状态存储目录' },
          out: { type: 'string', description: '可选，报告输出路径，默认 report.md' },
        },
        required: ['workspace'],
      },
      output: { schema: { type: 'object' }, render: (o) => o.markdown },
      execute: async (args) => {
        const store = new TeamStore(args.workspace);
        const { report, blockers, ok } = store.merge();
        const ws = resolveWorkspace(args.workspace || (config && config.defaultWorkspace));
        const out = resolveArtifactPath(ws, args.out, 'report.md');
        fs.writeFileSync(out, report, 'utf8');
        return { markdown: `${report}\n\n> 阻断项 ${blockers.length} ｜ ok=${ok} ｜ 报告已写入 \`${out}\``, blockers, ok };
      },
    },
  ];

  for (const t of tools) ctx.tools.register(defineTool(t));
}

exports.apply = function (ctx, config) {
  registerTools(ctx, config || {});
};
