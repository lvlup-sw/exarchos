// @ts-check
/**
 * @fileoverview Samples real matches from the tree so each pattern's precision
 * can be adjudicated before it is allowed to block.
 *
 * A pattern that fires on prose it should not spends more reviewer attention
 * than it saves, and the only way to know its rate is to read its actual
 * matches. Sampling is deterministic — sorted by path, then line, then take the
 * first N — so re-running it produces the same sample and the recorded verdicts
 * stay attached to the matches they were made about.
 *
 * This is a measurement instrument, not a gate. It reports; it never fails.
 *
 * Usage: `node tools/audit/lib/comment-precision-sample.mjs [--limit 50] [--out FILE]`
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadPolicy, isExempt } from './comment-policy.mjs';
import { extractComments, CommentExtractionError } from './comment-prose.mjs';
import { classifyText } from './comment-classifier.mjs';
import { analyzeFile } from './comment-analysis.mjs';
import { parseCommentFile } from './comment-parse.mjs';
import { PLACEMENT_RULE } from './comment-placement.mjs';
import { PROSE_RULE } from './comment-ste.mjs';
import { isInLintScope } from './lint-scope.mjs';

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx']);

/**
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function trackedSourceFiles(repoRoot) {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter((rel) => rel.length > 0 && CODE_EXTENSIONS.has(path.extname(rel)))
    .sort();
}

/**
 * Collect every match, grouped by pattern id.
 *
 * @param {string} repoRoot
 * @param {ReturnType<typeof loadPolicy>} policy
 */
export function collectMatches(repoRoot, policy) {
  // Sample with every pattern forced on. A pattern ships disabled precisely
  // because its rate is unknown, so sampling only the enabled ones would leave
  // the undecided case permanently unmeasurable.
  const measuring = {
    ...policy,
    forbiddenOrdinals: policy.forbiddenOrdinals.map((p) => ({ ...p, enabled: true })),
    changelogPatterns: policy.changelogPatterns.map((p) => ({ ...p, enabled: true })),
  };

  /** @type {Map<string, { file: string, line: number, match: string, prose: string }[]>} */
  const byPattern = new Map();
  /** @type {string[]} */
  const indeterminate = [];
  let scanned = 0;

  for (const rel of trackedSourceFiles(repoRoot)) {
    if (isExempt(policy, rel, 'comment-content')) continue;
    let source;
    try {
      source = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    let comments;
    try {
      comments = extractComments(source, rel);
    } catch (cause) {
      if (cause instanceof CommentExtractionError) {
        indeterminate.push(rel);
        continue;
      }
      throw cause;
    }
    scanned += 1;
    for (const comment of comments) {
      for (const finding of classifyText(comment.text, measuring)) {
        const bucket = byPattern.get(finding.patternId) ?? [];
        bucket.push({
          file: rel,
          line: comment.line,
          match: finding.match,
          prose: comment.text.slice(Math.max(0, finding.index - 90), finding.index + 110),
        });
        byPattern.set(finding.patternId, bucket);
      }
    }
  }

  return { byPattern, indeterminate, scanned };
}

/**
 * One match of a placement or prose check, with the source lines around the block.
 *
 * @typedef {object} CheckMatch
 * @property {string} file
 * @property {number} line
 * @property {string} message
 * @property {string} block The block text, cut at 4,000 characters.
 * @property {string} context Up to three source lines on each side of the block.
 */

/**
 * The policy with every placement and prose check enabled. A check ships disabled because its rate
 * is unknown, so the sample must still measure it.
 *
 * @param {ReturnType<typeof loadPolicy>} policy
 * @returns {ReturnType<typeof loadPolicy>}
 */
function measuringPolicy(policy) {
  const placement = policy.placement === undefined ? undefined : {
    ...policy.placement,
    checks: new Map([...policy.placement.checks].map(([id, check]) => [id, { ...check, enabled: true }])),
  };
  const prose = policy.prose === undefined ? undefined : {
    ...policy.prose,
    steChecks: policy.prose.steChecks.map((check) => ({ ...check, enabled: true })),
    budgets: new Map([...policy.prose.budgets].map(([id, budget]) => [id, { ...budget, enabled: true }])),
  };
  return { ...policy, placement, prose };
}

/**
 * Collect every match of the placement and prose checks, keyed by `rule/checkId`.
 *
 * @param {string} repoRoot
 * @param {ReturnType<typeof loadPolicy>} policy
 * @returns {{ byCheck: Map<string, CheckMatch[]>, scanned: number }}
 */
export function collectCheckMatches(repoRoot, policy) {
  const measuring = measuringPolicy(policy);
  /** @type {Map<string, CheckMatch[]>} */
  const byCheck = new Map();
  let scanned = 0;
  for (const rel of trackedSourceFiles(repoRoot)) {
    if (!isInLintScope(rel)) continue;
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const { blocks, syntax } = parseCommentFile(rel, text, repoRoot);
    if (syntax === undefined) continue;
    scanned += 1;
    const lines = text.split('\n');
    const { analyzed } = analyzeFile({ relPath: rel, blocks, policy: measuring, entries: undefined, syntax });
    for (const item of analyzed) {
      for (const finding of item.findings) {
        if (finding.rule !== PLACEMENT_RULE && finding.rule !== PROSE_RULE) continue;
        const key = `${finding.rule}/${finding.checkId}`;
        const bucket = byCheck.get(key) ?? [];
        bucket.push({
          file: rel,
          line: item.block.line,
          message: finding.message,
          block: item.block.raw.slice(0, 4000),
          context: lines.slice(Math.max(0, item.block.line - 4), item.block.endLine + 3).join('\n'),
        });
        byCheck.set(key, bucket);
      }
    }
  }
  return { byCheck, scanned };
}

/**
 * A deterministic sample spread over the whole tree: every k-th match, where k is the total over the
 * limit. The first matches in path order cluster in a few files, so a stride sample measures more of
 * the tree.
 *
 * @template T
 * @param {readonly T[]} all
 * @param {number} limit
 * @returns {T[]}
 */
export function strideSample(all, limit) {
  if (all.length <= limit) return [...all];
  return Array.from({ length: limit }, (_, i) => /** @type {T} */ (all[Math.floor((i * all.length) / limit)]));
}

/**
 * Every pattern the policy declares, including those shipping disabled — a
 * disabled pattern still needs its matches read before it can be turned on.
 *
 * @param {ReturnType<typeof loadPolicy>} policy
 */
function allPatterns(policy) {
  return [...policy.forbiddenOrdinals, ...policy.changelogPatterns];
}

function main() {
  const argv = process.argv.slice(2);
  const limitFlag = argv.indexOf('--limit');
  const limit = limitFlag >= 0 ? Number(argv[limitFlag + 1]) : 50;
  const outFlag = argv.indexOf('--out');
  const outPath = outFlag >= 0 ? argv[outFlag + 1] : undefined;

  const repoRoot = process.cwd();
  const policy = loadPolicy(path.join(repoRoot, '.exarchos/comment-policy.json'));
  const { byPattern, indeterminate, scanned } = collectMatches(repoRoot, policy);

  /** @type {Record<string, unknown>} */
  const report = {};
  for (const entry of allPatterns(policy)) {
    const all = byPattern.get(entry.id) ?? [];
    report[entry.id] = {
      enabled: entry.enabled,
      totalMatches: all.length,
      sampled: all.slice(0, limit),
      exhaustive: all.length <= limit,
    };
  }

  /** @type {Record<string, unknown>} */
  const checks = {};
  const { byCheck, scanned: parsed } = collectCheckMatches(repoRoot, policy);
  const declared = [
    ...[...(policy.placement?.checks.keys() ?? [])].map((id) => `${PLACEMENT_RULE}/${id}`),
    ...(policy.prose?.steChecks ?? []).map((check) => `${PROSE_RULE}/${check.id}`),
    ...[...(policy.prose?.budgets.keys() ?? [])].map((id) => `${PROSE_RULE}/${id}`),
  ];
  for (const key of declared) {
    const all = byCheck.get(key) ?? [];
    checks[key] = { totalMatches: all.length, sampled: strideSample(all, limit), exhaustive: all.length <= limit };
  }

  const payload = { scannedFiles: scanned, indeterminateFiles: indeterminate, patterns: report, parsedFiles: parsed, checks };
  const json = JSON.stringify(payload, null, 2);
  if (outPath) fs.writeFileSync(outPath, `${json}\n`, 'utf8');
  else process.stdout.write(`${json}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
