'use strict';
/*
 * index.js — DSH (DeepSeek Harness) / Cordis 4 插件入口
 * 导出契约：name / inject / Config / apply(ctx, config)
 * 通过 ctx.tools.register(defineTool({...})) 注册团队路由与调度工具。
 *
 * 安装：dsh plugin --profile web add <本目录或 npm 包>
 * 加载：cordis.patch.yml 将本插件注入 DSH 运行时。
 */

const fs = require('fs');
const path = require('path');
const { routeTask, catalog } = require('./router');
const { TeamStore } = require('./team');

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
      description: '将一段任务文本路由为合适的多角色团队编制（roster）。支持 --include 手动补位与 --exclude 排除。返回角色清单。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '任务描述文本' },
          include: { type: 'string', description: '可选，手动指定角色，形如 "Course Designer:creation;Training Facilitator:creation"，分号分隔' },
          exclude: { type: 'string', description: '可选，排除角色名，逗号分隔' },
          out: { type: 'string', description: '可选，roster 输出路径，默认 roster.json' },
        },
        required: ['task'],
      },
      output: {
        schema: { type: 'object' },
        render: (o) => o.markdown,
      },
      execute: async (args) => {
        const include = (args.include || '').split(';').map((s) => s.trim()).filter(Boolean);
        const exclude = (args.exclude || '').split(',').map((s) => s.trim()).filter(Boolean);
        const roster = routeTask(args.task, { include, exclude, rolesPath: resolveRolesPath(config) });
        const out = args.out || 'roster.json';
        fs.writeFileSync(out, JSON.stringify(roster, null, 2), 'utf8');
        return { markdown: `${summarizeRoster(roster)}\n\n> roster 已写入 \`${out}\``, roster };
      },
    },
    {
      name: 'team_router_catalog',
      description: '列出内置角色库全量目录（按域分组），用于了解可路由角色及 --include 可填的真实角色名。',
      parameters: { type: 'object', properties: {}, required: [] },
      output: { schema: { type: 'object' }, render: (o) => o.markdown },
      execute: async () => {
        const byDomain = catalog(resolveRolesPath(config));
        const lines = [];
        for (const d of Object.keys(byDomain)) {
          lines.push(`**${d}**`);
          for (const r of byDomain[d]) lines.push(`- ${r.name} [${r.phases.join('/')}] : ${r.duty}`);
        }
        return { markdown: `### 角色库目录\n${lines.join('\n')}` };
      },
    },
    {
      name: 'team_router_assemble',
      description: '将 roster.json 物化为一支可执行团队：展开成员、生成带阶段依赖的任务图。',
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
        const ws = args.workspace || (config && config.defaultWorkspace) || './.agent-team';
        const roster = JSON.parse(fs.readFileSync(args.rosterPath, 'utf8'));
        const store = new TeamStore(ws);
        const team = store.create(roster);
        const lines = team.tasks.map((t) => `- ${t.taskId} [${t.priority}] ${t.phaseLabel} ${t.name} ×${t.count} 依赖[${t.dependsOn.join(',') || '-'}]`);
        return { markdown: `✓ 建队 ${team.teamId} ｜ 成员 ${team.members.length} ｜ 任务 ${team.tasks.length}\n${lines.join('\n')}\n\n> 工作区: \`${ws}\``, team };
      },
    },
    {
      name: 'team_router_status',
      description: '查看团队当前状态：各任务进度、成员完成情况。',
      parameters: {
        type: 'object',
        properties: { workspace: { type: 'string', description: '团队状态存储目录' } },
        required: ['workspace'],
      },
      output: { schema: { type: 'object' }, render: (o) => o.markdown },
      execute: async (args) => {
        const store = new TeamStore(args.workspace);
        const s = store.status();
        const lines = s.progress.map((p) => `- ${p.taskId} ${p.phase} ${p.name} : ${p.status} (${p.membersDone}/${p.count})`);
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
      description: '把某成员指派到某任务（开始一次执行尝试）。',
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
        store.dispatch(args.task, args.member);
        return { markdown: `✓ 派工 ${args.task} → ${args.member}` };
      },
    },
    {
      name: 'team_router_complete',
      description: '标记某成员完成其任务尝试，并附上交付产出。当任务全部成员完成，沉淀为阶段制品。',
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
        return { markdown: `✓ 完成 ${args.task} / ${args.member} ｜ 任务全部完成：${r.allDone}` };
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
      name: 'team_router_merge',
      description: '汇总所有阶段制品生成交付报告，并执行质量门禁（产出需完成、审查需 pass）。返回报告与阻断项。',
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
        const out = args.out || 'report.md';
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
