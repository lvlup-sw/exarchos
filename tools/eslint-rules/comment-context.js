// @ts-check
/**
 * @fileoverview Shared state for the comment rules: the policy, the baseline and each file's analysis.
 *
 * All comment rules read one analysis per file, so they agree on blocks, findings and suppression.
 * The policy and the baseline resolve from the working directory first, then from this module's
 * repository. The `EXARCHOS_COMMENT_POLICY` and `EXARCHOS_COMMENT_BASELINE` variables override both.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy, DEFAULT_POLICY_PATH } from '../audit/lib/comment-policy.mjs';
import { loadBaseline, groupBlocks, DEFAULT_BASELINE_PATH } from '../audit/lib/comment-baseline.mjs';
import { analyzeFile } from '../audit/lib/comment-analysis.mjs';

/** The repository that holds this module. */
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Resolve a repository file. The order is the environment override, the working directory, then this module's repository.
 *
 * @param {string} relDefault
 * @param {string} envName
 * @param {string} cwd
 * @returns {string}
 */
function resolveRepoFile(relDefault, envName, cwd) {
  const override = process.env[envName];
  if (override !== undefined && override.length > 0) return path.resolve(override);
  const fromCwd = path.resolve(cwd, relDefault);
  return fs.existsSync(fromCwd) ? fromCwd : path.resolve(MODULE_ROOT, relDefault);
}

/**
 * The comment policy that the rules read.
 *
 * @param {string} [cwd]
 * @returns {string}
 */
export function resolvePolicyPath(cwd = process.cwd()) {
  return resolveRepoFile(DEFAULT_POLICY_PATH, 'EXARCHOS_COMMENT_POLICY', cwd);
}

/**
 * The comment baseline that the rules read.
 *
 * @param {string} [cwd]
 * @returns {string}
 */
export function resolveBaselinePath(cwd = process.cwd()) {
  return resolveRepoFile(DEFAULT_BASELINE_PATH, 'EXARCHOS_COMMENT_BASELINE', cwd);
}

/** @type {Map<string, ReturnType<typeof loadPolicy>>} */
const policies = new Map();
/** @type {Map<string, import('../audit/lib/comment-baseline.mjs').Baseline>} */
const baselines = new Map();
/** @type {WeakMap<object, FileAnalysis>} */
const analyses = new WeakMap();

/** Forget the loaded policy and baseline. Tests call this after they change an override. */
export function resetCaches() {
  policies.clear();
  baselines.clear();
}

/**
 * One file's analysis, shared by every comment rule.
 *
 * @typedef {ReturnType<typeof analyzeFile> & {
 *   relPath: string,
 *   locOf: (block: import('../audit/lib/comment-baseline.mjs').CommentBlock) => import('eslint').AST.SourceLocation,
 * }} FileAnalysis
 */

/**
 * The analysis of the file that a rule context lints. It is computed once per file.
 *
 * @param {import('eslint').Rule.RuleContext} context
 * @returns {FileAnalysis}
 */
export function analysisFor(context) {
  const { sourceCode } = context;
  const cached = analyses.get(sourceCode);
  if (cached !== undefined) return cached;
  const policyPath = resolvePolicyPath(context.cwd);
  const baselinePath = resolveBaselinePath(context.cwd);
  const policy = policies.get(policyPath) ?? loadPolicy(policyPath);
  policies.set(policyPath, policy);
  const baseline = baselines.get(baselinePath) ?? loadBaseline(baselinePath);
  baselines.set(baselinePath, baseline);
  const relPath = path.relative(context.cwd, context.filename).split(path.sep).join('/');
  const comments = sourceCode.getAllComments().map((comment) => ({
    type: String(comment.type),
    value: comment.value,
    range: /** @type {[number, number]} */ (comment.range ?? [0, 0]),
  }));
  const blocks = groupBlocks(comments, sourceCode.text);
  /** @type {FileAnalysis} */
  const result = {
    ...analyzeFile({ relPath, blocks, policy, entries: baseline.get(relPath) }),
    relPath,
    locOf: (block) => ({
      start: sourceCode.getLocFromIndex(block.start),
      end: sourceCode.getLocFromIndex(block.end),
    }),
  };
  analyses.set(sourceCode, result);
  return result;
}
