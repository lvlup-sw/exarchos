#!/usr/bin/env node
// @ts-check
/**
 * @fileoverview The comment gate. CI runs it as `npm run lint:comments`.
 *
 * `run` is the default. It does four checks:
 * - ESLint with the shared configuration.
 * - The content scan of shell, YAML and PowerShell comments.
 * - Baseline integrity, and baseline admission against the base branch.
 * `baseline prune` removes entries that no longer match. `baseline seed` adds entries after a
 * policy change, only for comment text that existed at the base. `report` prints every finding.
 *
 * Exit 0 is clean and exit 1 is findings. Exit 2 is fail-closed: a missing tool, an unreadable
 * policy or baseline, an unexpected ESLint status, or a pull request without its base branch.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadPolicy, DEFAULT_POLICY_PATH, PolicyError } from '../lib/comment-policy.mjs';
import {
  BaselineError,
  DEFAULT_BASELINE_PATH,
  countTextOccurrences,
  groupBlocks,
  parseBaseline,
  serializeBaseline,
} from '../lib/comment-baseline.mjs';
import { analyzeFile, liveEntries } from '../lib/comment-analysis.mjs';
import { sourceBlocks, sourceLanguage } from '../lib/comment-sources.mjs';
import { LINT_EXTENSIONS, LINT_GLOBS, globsMatch, isInLintScope } from '../lib/lint-scope.mjs';
import { GitBaseError, diffFromRef, readAtRef, resolveBase, trackedFiles } from '../lib/git-base.mjs';

/** The repository that holds this gate. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(import.meta.url);
const EXIT_CLEAN = 0;
const EXIT_FINDINGS = 1;
const EXIT_FAIL_CLOSED = 2;

/** Raised for any condition that must stop the gate with exit 2. */
class FailClosed extends Error {}

/**
 * The parsed command line.
 *
 * @typedef {object} Args
 * @property {'run' | 'prune' | 'seed' | 'report'} command
 * @property {string | undefined} base
 * @property {string} baselinePath Absolute.
 * @property {string} policyPath Absolute.
 * @property {string | undefined} config
 * @property {string[]} files Testability scope: lint and scan only these files.
 * @property {boolean} admission
 * @property {string[]} paths The paths for `report`.
 */

const USAGE = `Usage:
  node tools/audit/gates/lint-comments.mjs [run] [--base <ref>] [--no-admission] [--files <path>]...
  node tools/audit/gates/lint-comments.mjs baseline prune|seed [--base <ref>]
  node tools/audit/gates/lint-comments.mjs report <path>...
Testability flags: --baseline <path>, --config <path>, --files <path>.
`;

/**
 * Parse the command line.
 *
 * @param {readonly string[]} argv
 * @returns {Args}
 */
function parseArgs(argv) {
  /** @type {Args} */
  const args = {
    command: 'run',
    base: undefined,
    baselinePath: path.resolve(REPO_ROOT, process.env.EXARCHOS_COMMENT_BASELINE ?? DEFAULT_BASELINE_PATH),
    policyPath: path.resolve(REPO_ROOT, process.env.EXARCHOS_COMMENT_POLICY ?? DEFAULT_POLICY_PATH),
    config: undefined,
    files: [],
    admission: true,
    paths: [],
  };
  const rest = [...argv];
  if (rest[0] === 'run' || rest[0] === 'report') args.command = /** @type {'run' | 'report'} */ (rest.shift());
  else if (rest[0] === 'baseline') {
    rest.shift();
    const sub = rest.shift();
    if (sub !== 'prune' && sub !== 'seed') throw new FailClosed(`unknown baseline command: ${String(sub)}\n${USAGE}`);
    args.command = sub;
  }
  while (rest.length > 0) {
    const arg = /** @type {string} */ (rest.shift());
    const value = () => {
      const next = rest.shift();
      if (next === undefined) throw new FailClosed(`${arg} needs a value\n${USAGE}`);
      return next;
    };
    if (arg === '--base') args.base = value();
    else if (arg === '--baseline') args.baselinePath = path.resolve(value());
    else if (arg === '--config') args.config = path.resolve(value());
    else if (arg === '--files') args.files.push(value());
    else if (arg === '--no-admission') args.admission = false;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      process.exit(EXIT_CLEAN);
    } else if (args.command === 'report' && !arg.startsWith('--')) args.paths.push(arg);
    else throw new FailClosed(`unknown argument: ${arg}\n${USAGE}`);
  }
  return args;
}

/**
 * POSIX path relative to the repository root.
 *
 * @param {string} p
 * @returns {string}
 */
function rel(p) {
  return path.relative(REPO_ROOT, path.resolve(REPO_ROOT, p)).split(path.sep).join('/');
}

/**
 * Run the ESLint CLI with the shared configuration. The rules read the same baseline as the gate.
 *
 * @param {Args} args
 * @returns {number} 0 or 1.
 */
function runEslint(args) {
  let bin;
  try {
    bin = path.join(path.dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');
  } catch {
    throw new FailClosed('eslint is not installed (fail-closed). Run `npm install`.');
  }
  const targets = args.files.length > 0 ? args.files.filter((f) => isInLintScope(rel(f))) : [...LINT_GLOBS];
  if (targets.length === 0) return EXIT_CLEAN;
  const result = spawnSync(process.execPath, [bin, ...(args.config ? ['--config', args.config] : []), ...targets], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, EXARCHOS_COMMENT_BASELINE: args.baselinePath, EXARCHOS_COMMENT_POLICY: args.policyPath },
  });
  if (result.error) throw new FailClosed(`could not spawn eslint (fail-closed): ${result.error.message}`);
  if (result.status === EXIT_CLEAN || result.status === EXIT_FINDINGS) return result.status;
  throw new FailClosed(`eslint exited ${String(result.status)} (fail-closed)`);
}

/**
 * The comment blocks of one file, and its syntax tree for JavaScript and TypeScript.
 *
 * The parser is the one that the ESLint rules use, so the blocks and placements match.
 *
 * @param {string} relPath
 * @param {string} text
 * @returns {{ blocks: import('../lib/comment-baseline.mjs').CommentBlock[], syntax?: import('../lib/comment-analysis.mjs').FileSyntax }}
 */
function parseFile(relPath, text) {
  if (sourceLanguage(relPath) !== undefined) return { blocks: sourceBlocks(relPath, text) };
  if (!isInLintScope(relPath)) return { blocks: [] };
  const { Linter } = require('eslint');
  const { parser } = require('typescript-eslint');
  const linter = new Linter({ configType: 'flat', cwd: REPO_ROOT });
  const config = {
    files: [`**/*.{${LINT_EXTENSIONS.join(',')}}`],
    languageOptions: { parser },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  };
  const messages = linter.verify(text, [config], {
    filename: path.join(REPO_ROOT, relPath),
  });
  const fatal = messages.find((m) => m.fatal === true || m.message.startsWith('No matching configuration'));
  if (fatal !== undefined) throw new FailClosed(`${relPath} did not parse: ${fatal.message}`);
  const sourceCode = linter.getSourceCode();
  if (sourceCode === null) throw new FailClosed(`${relPath}: ESLint produced no source code.`);
  const comments = sourceCode.getAllComments().map((c) => ({
    type: String(c.type),
    value: c.value,
    range: /** @type {[number, number]} */ (c.range ?? [0, 0]),
  }));
  const ast = /** @type {import('../lib/comment-placement.mjs').EsNode} */ (/** @type {unknown} */ (sourceCode.ast));
  return { blocks: groupBlocks(comments, sourceCode.text), syntax: { ast, comments, text: sourceCode.text } };
}

/**
 * Analyze one file from disk, with its syntax tree when it has one.
 *
 * @param {string} relPath
 * @param {ReturnType<typeof loadPolicy>} policy
 * @param {ReadonlyMap<string, number> | undefined} entries
 * @param {typeof policy} [policyOverride] A policy variant, such as one without an exemption.
 * @returns {ReturnType<typeof analyzeFile>}
 */
function analyzeOnDisk(relPath, policy, entries, policyOverride) {
  const { blocks, syntax } = parseFile(relPath, fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8'));
  return analyzeFile({ relPath, blocks, policy: policyOverride ?? policy, entries, ...(syntax === undefined ? {} : { syntax }) });
}

/**
 * The files that the gate reads: the lint scope, plus shell, YAML and PowerShell files.
 *
 * @param {Args} args
 * @returns {string[]}
 */
function scopedFiles(args) {
  const all = args.files.length > 0 ? args.files.map(rel) : trackedFiles(REPO_ROOT);
  return all.filter(
    (p) => (isInLintScope(p) || sourceLanguage(p) !== undefined) && fs.existsSync(path.join(REPO_ROOT, p)),
  );
}

/**
 * Read the baseline. With `allowMissing`, a missing file is an empty baseline.
 *
 * @param {Args} args
 * @param {{ allowMissing?: boolean }} [options]
 * @returns {{ baseline: import('../lib/comment-baseline.mjs').Baseline, text: string }}
 */
function readBaseline(args, options = {}) {
  if (!fs.existsSync(args.baselinePath)) {
    if (options.allowMissing === true) return { baseline: new Map(), text: '' };
    throw new FailClosed(`comment baseline not found at ${rel(args.baselinePath)} (fail-closed).`);
  }
  const text = fs.readFileSync(args.baselinePath, 'utf8');
  return { baseline: parseBaseline(text, rel(args.baselinePath)), text };
}

/**
 * Integrity: the file is canonical, and every path exists and has a consumer.
 *
 * @param {import('../lib/comment-baseline.mjs').Baseline} baseline
 * @param {string} text
 * @returns {string[]}
 */
function checkIntegrity(baseline, text) {
  const problems = [];
  if (serializeBaseline(baseline) !== text) {
    problems.push('the baseline is not in canonical order. Rewrite it: `npm run lint:comments -- baseline prune`.');
  }
  for (const file of baseline.keys()) {
    if (!fs.existsSync(path.join(REPO_ROOT, file))) {
      problems.push(`${file}: the baseline lists a file that does not exist. Run \`npm run lint:comments -- baseline prune\`.`);
    } else if (!isInLintScope(file) && sourceLanguage(file) === undefined) {
      problems.push(`${file}: the baseline lists a file that no comment rule reads.`);
    }
  }
  return problems;
}

/**
 * The content scan of shell, YAML and PowerShell files. ESLint covers the lint scope.
 *
 * @param {Args} args
 * @param {ReturnType<typeof loadPolicy>} policy
 * @param {import('../lib/comment-baseline.mjs').Baseline} baseline
 * @returns {string[]}
 */
function scanSources(args, policy, baseline) {
  const problems = [];
  for (const file of scopedFiles(args).filter((p) => sourceLanguage(p) !== undefined)) {
    const { analyzed, stale } = analyzeOnDisk(file, policy, baseline.get(file));
    for (const item of analyzed) {
      if (item.suppressed) continue;
      for (const finding of item.findings) problems.push(`${file}:${item.block.line}  ${finding.message}  (comments/${finding.rule})`);
    }
    for (const entry of stale) {
      problems.push(
        `${file}: the baseline lists ${entry.count} block(s) with hash ${entry.hash}, but ${entry.live} still break a rule. ` +
          'Run `npm run lint:comments -- baseline prune`.',
      );
    }
  }
  return problems;
}

/**
 * The exemption pairs (glob and rule) that a raw policy document declares. A v1 entry covers every rule.
 *
 * @param {unknown} doc
 * @param {readonly string[]} roster
 * @returns {{ glob: string, rule: string }[]}
 */
function exemptionPairs(doc, roster) {
  const entries = Array.isArray(/** @type {{ exemptPaths?: unknown }} */ (doc)?.exemptPaths)
    ? /** @type {{ glob?: unknown, rules?: unknown }[]} */ (/** @type {{ exemptPaths: unknown[] }} */ (doc).exemptPaths)
    : [];
  return entries.flatMap((entry) => {
    if (typeof entry.glob !== 'string') return [];
    const rules = Array.isArray(entry.rules) ? entry.rules.filter((r) => typeof r === 'string') : roster;
    return rules.map((rule) => ({ glob: /** @type {string} */ (entry.glob), rule }));
  });
}

/**
 * How many blocks a new exemption hides that did not exist at the base.
 *
 * @param {string} file
 * @param {string} baseFile
 * @param {{ glob: string, rule: string }} pair
 * @param {ReturnType<typeof loadPolicy>} policy
 * @param {string} baseRef
 * @returns {number}
 */
function hiddenNewText(file, baseFile, pair, policy, baseRef) {
  const without = { ...policy, exemptPaths: policy.exemptPaths.filter((entry) => entry.glob !== pair.glob) };
  const { analyzed } = analyzeOnDisk(file, policy, undefined, without);
  const baseText = readAtRef(baseRef, [baseFile], REPO_ROOT).get(baseFile) ?? '';
  /** @type {Map<string, { raw: string, count: number }>} */
  const byHash = new Map();
  for (const item of analyzed) {
    if (!item.findings.some((finding) => finding.rule === pair.rule)) continue;
    const seen = byHash.get(item.hash) ?? { raw: item.block.raw, count: 0 };
    byHash.set(item.hash, { raw: seen.raw, count: seen.count + 1 });
  }
  let hidden = 0;
  for (const { raw, count } of byHash.values()) hidden += Math.max(0, count - countTextOccurrences(baseText, raw));
  return hidden;
}

/**
 * Admission: compare the baseline and the policy with the base branch.
 *
 * @param {Args} args
 * @param {ReturnType<typeof loadPolicy>} policy
 * @param {import('../lib/comment-baseline.mjs').Baseline} baseline
 * @returns {string[]}
 */
function checkAdmission(args, policy, baseline) {
  const base = resolveBase({ cwd: REPO_ROOT, env: process.env, explicit: args.base });
  if (base.ref === undefined) {
    process.stdout.write(`lint-comments: admission skipped (${base.reason}).\n`);
    return [];
  }
  const baselineRel = rel(args.baselinePath);
  const policyRel = rel(args.policyPath);
  const atBase = readAtRef(base.ref, [baselineRel, policyRel], REPO_ROOT);
  const baseBaselineText = atBase.get(baselineRel);
  const basePolicyText = atBase.get(policyRel);
  const bootstrap = baseBaselineText === undefined;
  const policyChanged = basePolicyText !== fs.readFileSync(args.policyPath, 'utf8');
  const baseBaseline = bootstrap ? new Map() : parseBaseline(baseBaselineText, `${base.ref}:${baselineRel}`);
  const { renamedFrom, added } = diffFromRef(base.ref, REPO_ROOT);
  const problems = [];
  /** @type {{ file: string, baseFile: string, hash: string, count: number }[]} */
  const grown = [];
  for (const [file, entries] of baseline) {
    const baseFile = renamedFrom.get(file) ?? file;
    for (const [hash, count] of entries) {
      const baseCount = baseBaseline.get(baseFile)?.get(hash) ?? 0;
      if (count <= baseCount) continue;
      if (!bootstrap && !policyChanged) {
        problems.push(
          `${file}: the baseline count for ${hash} grew from ${baseCount} to ${count}, but this change does not edit ` +
            `${policyRel}. The baseline only shrinks unless the policy changes.`,
        );
      } else grown.push({ file, baseFile, hash, count });
    }
  }
  const baseTexts = readAtRef(base.ref, [...new Set(grown.map((g) => g.baseFile))], REPO_ROOT);
  /** @type {Map<string, ReturnType<typeof analyzeFile>>} */
  const analysisCache = new Map();
  for (const { file, baseFile, hash, count } of grown) {
    const analysis = analysisCache.get(file) ?? analyzeOnDisk(file, policy, undefined);
    analysisCache.set(file, analysis);
    const block = analysis.analyzed.find((item) => item.hash === hash);
    const baseText = baseTexts.get(baseFile);
    const available = block === undefined || baseText === undefined ? 0 : countTextOccurrences(baseText, block.block.raw);
    if (count > available) {
      problems.push(
        `${file}: the baseline lists ${count} block(s) with hash ${hash}, but only ${available} existed at ${base.ref}. ` +
          'New comment text cannot enter the baseline. Fix the comment.',
      );
    }
  }
  if (policyChanged && basePolicyText !== undefined) {
    const basePairs = exemptionPairs(JSON.parse(basePolicyText), policy.rules);
    const fresh = exemptionPairs(JSON.parse(fs.readFileSync(args.policyPath, 'utf8')), policy.rules).filter(
      (pair) => !basePairs.some((b) => b.glob === pair.glob && b.rule === pair.rule),
    );
    for (const pair of fresh) {
      for (const file of trackedFiles(REPO_ROOT).filter((p) => globsMatch([pair.glob], p))) {
        const baseFile = renamedFrom.get(file) ?? file;
        const exemptAtBase = basePairs.some((b) => b.rule === pair.rule && globsMatch([b.glob], baseFile));
        if (added.has(file) || exemptAtBase) continue;
        const hidden = hiddenNewText(file, baseFile, pair, policy, base.ref);
        if (hidden > 0) {
          problems.push(
            `${file}: the new exemption ${pair.glob} (${pair.rule}) hides ${hidden} comment block(s) that did not exist at ` +
              `${base.ref}. A new exemption can hide only text that existed at the base, or files that this change adds.`,
          );
        }
      }
    }
  }
  return problems;
}

/**
 * `run`: every check. Returns the exit code.
 *
 * @param {Args} args
 * @returns {number}
 */
function commandRun(args) {
  const policy = loadPolicy(args.policyPath);
  const { baseline, text } = readBaseline(args);
  const eslintStatus = runEslint(args);
  const problems = [
    ...checkIntegrity(baseline, text),
    ...scanSources(args, policy, baseline),
    ...(args.admission ? checkAdmission(args, policy, baseline) : []),
  ];
  for (const problem of problems) process.stderr.write(`lint-comments: ${problem}\n`);
  const baselined = [...baseline.values()].reduce((sum, entries) => sum + [...entries.values()].reduce((a, b) => a + b, 0), 0);
  const clean = eslintStatus === EXIT_CLEAN && problems.length === 0;
  process.stdout.write(`lint-comments: ${clean ? 'clean' : 'findings'}. The baseline holds ${baselined} block(s) in ${baseline.size} file(s).\n`);
  return clean ? EXIT_CLEAN : EXIT_FINDINGS;
}

/**
 * `baseline prune`: keep each entry only up to the blocks that still break a rule, and follow renames.
 *
 * @param {Args} args
 * @returns {number}
 */
function commandPrune(args) {
  const policy = loadPolicy(args.policyPath);
  const { baseline } = readBaseline(args);
  const base = resolveBase({ cwd: REPO_ROOT, env: {}, explicit: args.base });
  /** @type {Map<string, string>} */
  const renamedTo = new Map();
  if (base.ref !== undefined) for (const [to, from] of diffFromRef(base.ref, REPO_ROOT).renamedFrom) renamedTo.set(from, to);
  /** @type {import('../lib/comment-baseline.mjs').Baseline} */
  const next = new Map();
  let removed = 0;
  for (const [file, entries] of baseline) {
    const target = fs.existsSync(path.join(REPO_ROOT, file)) ? file : renamedTo.get(file);
    const total = [...entries.values()].reduce((a, b) => a + b, 0);
    if (target === undefined || !fs.existsSync(path.join(REPO_ROOT, target))) {
      removed += total;
      continue;
    }
    const live = liveEntries(analyzeOnDisk(target, policy, undefined).analyzed);
    const kept = next.get(target) ?? new Map();
    for (const [hash, count] of entries) {
      const keep = Math.min(count + (kept.get(hash) ?? 0), live.get(hash) ?? 0);
      removed += count + (kept.get(hash) ?? 0) - keep;
      if (keep > 0) kept.set(hash, keep);
      else kept.delete(hash);
    }
    if (kept.size > 0) next.set(target, kept);
  }
  fs.writeFileSync(args.baselinePath, serializeBaseline(next));
  process.stdout.write(`lint-comments: pruned ${removed} baselined block(s); ${rel(args.baselinePath)} is canonical.\n`);
  return EXIT_CLEAN;
}

/**
 * `baseline seed`: add entries for current findings, only up to the copies of that text at the base.
 *
 * @param {Args} args
 * @returns {number}
 */
function commandSeed(args) {
  const policy = loadPolicy(args.policyPath);
  const { baseline } = readBaseline(args, { allowMissing: true });
  const base = resolveBase({ cwd: REPO_ROOT, env: {}, explicit: args.base });
  if (base.ref === undefined) throw new FailClosed(`baseline seed needs a base branch (${base.reason}).`);
  const { renamedFrom } = diffFromRef(base.ref, REPO_ROOT);
  const files = scopedFiles(args);
  const baseTexts = readAtRef(base.ref, files.map((f) => renamedFrom.get(f) ?? f), REPO_ROOT);
  let added = 0;
  const refused = [];
  for (const file of files) {
    const { analyzed } = analyzeOnDisk(file, policy, undefined);
    const live = liveEntries(analyzed);
    const entries = baseline.get(file) ?? new Map();
    const baseText = baseTexts.get(renamedFrom.get(file) ?? file);
    for (const [hash, liveCount] of live) {
      const current = entries.get(hash) ?? 0;
      if (liveCount <= current) continue;
      const block = analyzed.find((item) => item.hash === hash);
      const available = block === undefined || baseText === undefined ? 0 : countTextOccurrences(baseText, block.block.raw);
      const target = Math.max(current, Math.min(liveCount, available));
      if (target > current) {
        entries.set(hash, target);
        added += target - current;
      }
      if (liveCount > target && block !== undefined) refused.push(`${file}:${block.block.line}`);
    }
    if (entries.size > 0) baseline.set(file, entries);
  }
  fs.mkdirSync(path.dirname(args.baselinePath), { recursive: true });
  fs.writeFileSync(args.baselinePath, serializeBaseline(baseline));
  process.stdout.write(`lint-comments: seeded ${added} block(s) against ${base.ref}.\n`);
  for (const where of refused) process.stdout.write(`lint-comments: not admitted, new text: ${where}\n`);
  return refused.length === 0 ? EXIT_CLEAN : EXIT_FINDINGS;
}

/**
 * `report`: print every finding in the named files, with its baseline state.
 *
 * @param {Args} args
 * @returns {number}
 */
function commandReport(args) {
  const policy = loadPolicy(args.policyPath);
  const { baseline } = readBaseline(args, { allowMissing: true });
  let count = 0;
  for (const file of args.paths.map(rel)) {
    const { analyzed } = analyzeOnDisk(file, policy, baseline.get(file));
    for (const item of analyzed) {
      for (const finding of item.findings) {
        count += 1;
        const state = item.suppressed ? 'baselined' : 'new';
        process.stdout.write(`${file}:${item.block.line}  [${state}] comments/${finding.rule}/${finding.checkId}  ${finding.message}\n`);
      }
    }
  }
  process.stdout.write(`lint-comments: ${count} finding(s).\n`);
  return EXIT_CLEAN;
}

/**
 * Entry point.
 *
 * @returns {number}
 */
function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === 'prune') return commandPrune(args);
    if (args.command === 'seed') return commandSeed(args);
    if (args.command === 'report') return commandReport(args);
    return commandRun(args);
  } catch (error) {
    const known = error instanceof FailClosed || error instanceof PolicyError || error instanceof BaselineError || error instanceof GitBaseError;
    const detail = known ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`lint-comments: ${detail} (fail-closed)\n`);
    return EXIT_FAIL_CLOSED;
  }
}

process.exitCode = main();
