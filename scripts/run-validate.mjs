#!/usr/bin/env node
/**
 * run-validate — the aggregating `npm run validate` runner (task 064, DR-24).
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 * `validate` was an `&&` chain written inline in package.json. Measured on the
 * integration tip on 2026-08-07: step 1 (`scripts/validate-plugin.sh`) exited 1,
 * so 1 of 9 declared steps executed and 8 never ran. The output was one failure
 * report — which to a human reader is indistinguishable from "one gate is red,
 * the other eight are green". Every later gate was SKIPPED-AS-PASSED. That is
 * #1711's failure mode, the one the program already fights inside CI, occurring
 * one layer up in the thing a developer runs to convince themselves CI will pass.
 *
 * ── The fix is structural, not detective ────────────────────────────────────
 * Aggregate rather than short-circuit: run EVERY declared step regardless of
 * earlier outcomes, then report each step's own verdict and exit code. This
 * removes the class. A step-count assertion alone would only DETECT it — and
 * only after someone read the number.
 *
 * The count assertion is kept anyway as a second tooth, because a step can also
 * fail to execute for reasons the loop does not control (a spawn error, a
 * killed process). Crucially, `declared` is `steps.length` read from
 * `scripts/validate-manifest.json`. It is never a literal in this file: a
 * hard-coded expected count is the identical defect one level up, drifting the
 * first time someone appends a step, and reading green while it drifts.
 *
 * ── Non-empty denominator ───────────────────────────────────────────────────
 * A run that executes ZERO steps FAILS loudly. So does a manifest that declares
 * zero. "Nothing to do" and "everything passed" must not print the same thing;
 * conflating them is how the original chain hid eight gates for months.
 *
 * Usage: run-validate.mjs [--manifest <path>] [--json] [--list]
 *
 * Exit codes:
 *   0 = every declared step executed and passed
 *   1 = a step failed, or the run truncated, or the denominator was empty
 *   2 = usage error, or the manifest could not be read (fail closed)
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
export const DEFAULT_MANIFEST_PATH = path.join('scripts', 'validate-manifest.json');

/**
 * @typedef {object} ValidateStep
 * @property {string} id
 * @property {string} command
 * @property {string[]} args
 * @property {string} [why]
 */

/**
 * @typedef {object} StepOutcome
 * @property {string} id
 * @property {string} command   The rendered command line, for the report.
 * @property {boolean} executed Whether the step actually ran to a verdict.
 * @property {number | null} status Exit code, or null when the step never ran.
 * @property {boolean} passed
 * @property {string} [error]   Spawn-level failure detail (ENOENT, signal, …).
 */

/**
 * Read + validate the manifest's shape.
 *
 * Every field is required. A step missing `command` is a manifest a runner
 * cannot execute, and silently skipping it would re-create the very hole this
 * runner exists to close — so it is a hard error, not a warning.
 *
 * @param {unknown} json
 * @returns {{ steps: ValidateStep[] } | { error: string }}
 */
export function parseManifest(json) {
  if (json === null || typeof json !== 'object') {
    return { error: 'manifest is not a JSON object' };
  }
  const rawSteps = json.steps;
  if (!Array.isArray(rawSteps)) {
    return { error: 'manifest has no `steps` array' };
  }
  /** @type {ValidateStep[]} */
  const steps = [];
  const seen = new Set();
  for (const [index, raw] of rawSteps.entries()) {
    if (raw === null || typeof raw !== 'object') {
      return { error: `steps[${index}] is not an object` };
    }
    const { id, command, args, why } = raw;
    if (typeof id !== 'string' || id === '') return { error: `steps[${index}] has no \`id\`` };
    if (seen.has(id)) return { error: `steps[${index}] repeats the id "${id}"` };
    seen.add(id);
    if (typeof command !== 'string' || command === '') {
      return { error: `step "${id}" has no \`command\`` };
    }
    if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
      return { error: `step "${id}" has a non-string-array \`args\`` };
    }
    steps.push({ id, command, args: args ?? [], ...(typeof why === 'string' ? { why } : {}) });
  }
  return { steps };
}

/** Render a step as the command line a human would retype to reproduce it. */
export function renderCommand(step) {
  return [step.command, ...step.args].join(' ');
}

/**
 * Execute every step, unconditionally.
 *
 * There is deliberately no early `break` and no `if (failed) return` in this
 * loop. The absence is the fix.
 *
 * @param {ValidateStep[]} steps
 * @param {(step: ValidateStep) => { status: number | null, error?: string }} runStep
 * @returns {StepOutcome[]}
 */
export function runAllSteps(steps, runStep) {
  /** @type {StepOutcome[]} */
  const outcomes = [];
  for (const step of steps) {
    const command = renderCommand(step);
    let result;
    try {
      result = runStep(step);
    } catch (error) {
      // A throwing runner must not abort the remaining steps either — that
      // would restore short-circuiting through the back door.
      result = { status: null, error: error instanceof Error ? error.message : String(error) };
    }
    const executed = typeof result.status === 'number';
    outcomes.push({
      id: step.id,
      command,
      executed,
      status: executed ? result.status : null,
      passed: result.status === 0,
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
  }
  return outcomes;
}

/**
 * Turn declared steps + outcomes into the run's verdict.
 *
 * `declared` comes from the manifest, never from a literal here.
 *
 * @param {ValidateStep[]} steps
 * @param {StepOutcome[]} outcomes
 * @returns {{ ok: boolean, declared: number, executed: number, passed: number, failed: number, violations: string[] }}
 */
export function summarize(steps, outcomes) {
  const declared = steps.length;
  const executed = outcomes.filter((o) => o.executed).length;
  const passed = outcomes.filter((o) => o.passed).length;
  const failed = outcomes.filter((o) => !o.passed).length;
  /** @type {string[]} */
  const violations = [];

  if (declared === 0) {
    violations.push(
      '[empty-manifest]  the validate manifest declares ZERO steps — a run with ' +
        'nothing to do must not report the same thing as a run where everything ' +
        'passed (DR-24 non-empty denominator)',
    );
  } else if (executed === 0) {
    violations.push(
      `[empty-run]  ZERO of ${declared} declared steps executed — the runner ` +
        'reached no gate at all, which is a failure, not a pass',
    );
  } else if (executed !== declared) {
    violations.push(
      `[truncated-run]  ${executed} of ${declared} declared steps executed — ` +
        `${steps
          .filter((s) => outcomes.find((o) => o.id === s.id)?.executed !== true)
          .map((s) => s.id)
          .join(', ')} never ran. A step that did not run is NOT a step that passed.`,
    );
  }

  return { ok: violations.length === 0 && failed === 0, declared, executed, passed, failed, violations };
}

/** The end-of-run report. Every declared step appears, run or not. */
export function renderSummary(outcomes, summary) {
  const lines = ['', '═'.repeat(72), 'npm run validate — aggregate result', '═'.repeat(72), ''];
  for (const outcome of outcomes) {
    const verdict = !outcome.executed ? 'NOT RUN' : outcome.passed ? 'PASS   ' : 'FAIL   ';
    const suffix = !outcome.executed
      ? ` (${outcome.error ?? 'never executed'})`
      : outcome.passed
        ? ''
        : ` (exit ${outcome.status})`;
    lines.push(`  ${verdict}  ${outcome.id.padEnd(30)} ${outcome.command}${suffix}`);
  }
  lines.push('');
  lines.push(
    `  ${summary.executed}/${summary.declared} declared steps executed · ` +
      `${summary.passed} passed · ${summary.failed} failed`,
  );
  for (const violation of summary.violations) lines.push(`  ${violation}`);
  lines.push('');
  lines.push(summary.ok ? 'validate: PASS' : 'validate: FAIL');
  return lines.join('\n');
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const USAGE = `Usage: run-validate.mjs [--manifest <path>] [--json] [--list]

Runs EVERY step declared in ${DEFAULT_MANIFEST_PATH}, aggregating failures
instead of short-circuiting on the first one, and reports each step's verdict.

Options:
  --manifest <path>  Manifest to run (default: ${DEFAULT_MANIFEST_PATH})
  --list             Print the declared steps and exit without running them
  --json             Emit the machine-readable report on stdout
  --help             Show this message

Exit codes:
  0  Every declared step executed and passed
  1  A step failed, the run truncated, or the denominator was empty
  2  Usage error, or the manifest could not be read (fail closed)`;

function parseArgs(argv) {
  const options = { manifest: DEFAULT_MANIFEST_PATH, json: false, list: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--manifest') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--manifest requires a path');
      options.manifest = value;
      i += 1;
    } else throw new Error(`Unknown argument '${arg}'`);
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const manifestPath = path.resolve(REPO_ROOT, options.manifest);
  let manifestJson;
  try {
    manifestJson = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    // Fail CLOSED: an unreadable manifest means the runner knows of no gates,
    // and "knows of no gates" must never render as "all gates passed".
    process.stderr.write(
      `Error: validate manifest ${options.manifest} could not be read — ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  const parsed = parseManifest(manifestJson);
  if ('error' in parsed) {
    process.stderr.write(`Error: validate manifest ${options.manifest} is malformed — ${parsed.error}\n`);
    return 2;
  }
  const { steps } = parsed;

  if (options.list) {
    process.stdout.write(
      `${steps.length} declared step(s) in ${options.manifest}:\n` +
        steps.map((s) => `  ${s.id.padEnd(30)} ${renderCommand(s)}`).join('\n') +
        '\n',
    );
    return steps.length === 0 ? 1 : 0;
  }

  const quiet = options.json;
  const outcomes = runAllSteps(steps, (step) => {
    if (!quiet) {
      process.stdout.write(`\n── ${step.id} ── ${renderCommand(step)}\n`);
    }
    const result = spawnSync(step.command, step.args, {
      cwd: REPO_ROOT,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      encoding: 'utf8',
    });
    if (result.error) return { status: null, error: result.error.message };
    if (result.status === null) {
      return { status: null, error: `terminated by signal ${result.signal ?? 'unknown'}` };
    }
    return { status: result.status };
  });

  const summary = summarize(steps, outcomes);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, steps: outcomes }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderSummary(outcomes, summary)}\n`);
  }
  return summary.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
