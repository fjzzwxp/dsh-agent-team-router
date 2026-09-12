'use strict';
/*
 * paths.js — 路径隔离工具（v2.0.1 新增）
 * 修复报告 ②：DSH 工具在插件进程 CWD 下运行，相对路径写盘会污染用户项目根目录。
 * 集中收敛所有产物的落盘位置到「显式/绝对」的工作空间目录，避免散落。
 */

const os = require('os');
const path = require('path');

/**
 * 解析工作空间为绝对路径。
 * - explicit 为空 → 使用 './.agent-team' 兜底（仍会被 path.resolve 钉到当前 CWD 下的绝对路径）
 * - explicit 以 ~ 开头 → 展开为用户主目录
 * - 其余 → path.resolve 转绝对（相对路径基于进程 CWD 解析，但结果仍是绝对路径，可预测）
 * @param {string} [explicit] 调用方显式传入的工作空间
 * @returns {string} 绝对路径
 */
function resolveWorkspace(explicit) {
  const base = explicit || './.agent-team';
  if (typeof base === 'string' && base.startsWith('~')) {
    return path.join(os.homedir(), base.slice(1));
  }
  return path.resolve(base);
}

/**
 * 解析产物落盘路径。
 * - explicit 为空 → 落在工作空间内（filename）
 * - explicit 为绝对路径 → 原样尊重
 * - explicit 为相对路径 → 解析到工作空间内（绝不散落到工作空间之外的 CWD）
 * @param {string} ws 工作空间绝对路径
 * @param {string} [explicit] 调用方显式传入的产物路径
 * @param {string} filename 默认文件名（explicit 为空时使用）
 * @returns {string} 绝对产物路径
 */
function resolveArtifactPath(ws, explicit, filename) {
  if (!explicit) return path.join(ws, filename);
  if (path.isAbsolute(explicit)) return explicit;
  return path.join(ws, explicit);
}

module.exports = { resolveWorkspace, resolveArtifactPath };
