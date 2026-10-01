#!/usr/bin/env node
/**
 * run-validate: the runner behind `npm run validate`. It runs every step that
 * `tools/audit/gates/validate-manifest.json` declares, whatever the earlier results, and
 * reports the verdict and exit code of each step. An `&&` chain stops at the first failure,
 * so the later gates read as passed although they never ran.
 *
 * The run fails when the executed count differs from `steps.length` in the manifest, and when
 * the manifest or the run has zero steps. A step can declare what a non-zero exit code means in
 * `outcomes`. Exit 0 cannot be declared, an undeclared non-zero code fails, and an advisory
 * outcome must have `expires` and `issue`.
 *
 * Usage: run-validate.mjs [--manifest <path>] [--json] [--list]
 * Exit 0: every step ran and passed or hit a live advisory. Exit 1: a step failed, the run
 * truncated, or a count was zero. Exit 2: usage error, or an unreadable manifest.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
export const DEFAULT_MANIFEST_PATH = path.join('tools', 'audit', 'gates', 'validate-manifest.json');

/**
 * @typedef {object} DeclaredOutcome
 * @property {string} verdict    Rendered in place of PASS/FAIL, for example `gaps`.
 * @property {'advisory' | 'fail'} severity
 * @property {string} [issue]    Tracking issue for the toleration.
 * @property {string} [expires]  `YYYY-MM-DD`. Required when the severity is advisory.
 * @property {string} [why]
 */

/**
 * @typedef {object} ValidateStep
 * @property {string} id
 * @property {string} command
 * @property {string[]} args
 * @property {string} [why]
 * @property {Record<string, DeclaredOutcome>} [outcomes] Exit code → meaning.
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

/** Severity a step's outcome carries once classified. */
const PASS = 'pass';
const TOLERATED = 'tolerated';
const FAILED = 'failed';
const NOT_RUN = 'not-run';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads and validates the shape of the manifest. Each step needs an `id` and a `command`.
 * A step that the runner cannot execute is an error, not a skip.
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
    const outcomes = parseDeclaredOutcomes(id, raw.outcomes);
    if ('error' in outcomes) return outcomes;
    steps.push({
      id,
      command,
      args: args ?? [],
      ...(typeof why === 'string' ? { why } : {}),
      ...(outcomes.outcomes === undefined ? {} : { outcomes: outcomes.outcomes }),
    });
  }
  return { steps };
}

/**
 * Validates the `outcomes` of a step. Each rule closes a route to a silent pass.
 * Exit 0 cannot be declared, and a verdict cannot be "pass". An advisory needs `expires`
 * and `issue`. A malformed block is a manifest error, not an ignored key.
 *
 * @param {string} stepId
 * @param {unknown} raw
 * @returns {{ outcomes?: Record<string, DeclaredOutcome> } | { error: string }}
 */
export function parseDeclaredOutcomes(stepId, raw) {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `step "${stepId}" has a non-object \`outcomes\`` };
  }
  /** @type {Record<string, DeclaredOutcome>} */
  const declared = {};
  for (const [code, value] of Object.entries(raw)) {
    if (!/^[0-9]+$/.test(code)) {
      return { error: `step "${stepId}" declares outcome key "${code}", which is not an exit code` };
    }
    if (Number(code) === 0) {
      return {
        error:
          `step "${stepId}" declares an outcome for exit code 0. Exit 0 is PASS and ` +
          `may not be redefined — a step that renamed its pass code could report ` +
          `anything it liked as success.`,
      };
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { error: `step "${stepId}" outcome ${code} is not an object` };
    }
    const { verdict, severity, issue, expires, why } = value;
    if (typeof verdict !== 'string' || verdict.trim() === '') {
      return { error: `step "${stepId}" outcome ${code} has no \`verdict\`` };
    }
    if (verdict.trim().toLowerCase() === 'pass') {
      return {
        error:
          `step "${stepId}" outcome ${code} names its verdict "pass". A non-zero ` +
          `exit is not a pass; that conflation is the defect this field exists to close.`,
      };
    }
    if (severity !== 'advisory' && severity !== 'fail') {
      return {
        error: `step "${stepId}" outcome ${code} has severity ${JSON.stringify(severity)}; expected 'advisory' or 'fail'`,
      };
    }
    if (severity === 'advisory') {
      if (typeof expires !== 'string' || !ISO_DAY.test(expires)) {
        return {
          error:
            `step "${stepId}" outcome ${code} is advisory but has no \`expires\` ` +
            `(YYYY-MM-DD). A toleration with no expiry is permanent by default.`,
        };
      }
      if (typeof issue !== 'string' || issue.trim() === '') {
        return {
          error:
            `step "${stepId}" outcome ${code} is advisory but names no \`issue\`. ` +
            `A tolerated non-pass needs somewhere for its removal to be tracked.`,
        };
      }
    }
    declared[code] = {
      verdict: verdict.trim(),
      severity,
      ...(typeof issue === 'string' ? { issue } : {}),
      ...(typeof expires === 'string' ? { expires } : {}),
      ...(typeof why === 'string' ? { why } : {}),
    };
  }
  return { outcomes: declared };
}

/** Renders a step as the command line that reproduces it. */
export function renderCommand(step) {
  return [step.command, ...step.args].join(' ');
}

/**
 * Executes every step. The loop has no early exit. A `runStep` that throws gives a
 * not-run outcome, and the loop continues.
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

/** Today, UTC, as `YYYY-MM-DD`. */
function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Classifies one step outcome against its declared outcomes. Exit 0 is a pass, a step that
 * did not run is `not-run`, and an undeclared code fails. An advisory holds through its
 * `expires` day. `check-measured-premises.mjs` reads `--tolerate-gaps-until` the same way.
 *
 * @param {ValidateStep | undefined} step
 * @param {StepOutcome} outcome
 * @param {string} [today] `YYYY-MM-DD`, injectable so the expiry tooth is testable.
 * @returns {{ severity: string, verdict: string, note?: string }}
 */
export function classifyOutcome(step, outcome, today = utcToday()) {
  if (!outcome.executed) return { severity: NOT_RUN, verdict: 'not run' };
  if (outcome.status === 0) return { severity: PASS, verdict: 'pass' };

  const declared = step?.outcomes?.[String(outcome.status)];
  if (declared === undefined) {
    return { severity: FAILED, verdict: 'fail' };
  }
  if (declared.severity === 'fail') {
    return { severity: FAILED, verdict: declared.verdict };
  }
  const expires = declared.expires ?? '';
  if (expires < today) {
    return {
      severity: FAILED,
      verdict: declared.verdict,
      note:
        `advisory toleration expired ${expires} (today ${today}) — ` +
        `resolve ${declared.issue ?? 'the tracking issue'} or re-declare it`,
    };
  }
  return {
    severity: TOLERATED,
    verdict: declared.verdict,
    note: `tolerated until ${expires}${declared.issue ? ` (${declared.issue})` : ''}`,
  };
}

/**
 * Turns the steps and outcomes into the run verdict. `declared` is `steps.length`, never a
 * literal. A tolerated step goes to `notices`, so a reader still sees that it did not pass.
 *
 * @param {ValidateStep[]} steps
 * @param {StepOutcome[]} outcomes
 * @param {string} [today] `YYYY-MM-DD`, injectable for the advisory-expiry tooth.
 * @returns {{ ok: boolean, declared: number, executed: number, passed: number, tolerated: number, failed: number, violations: string[], notices: string[], classifications: Record<string, { severity: string, verdict: string, note?: string }> }}
 */
export function summarize(steps, outcomes, today = utcToday()) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  /** @type {Record<string, { severity: string, verdict: string, note?: string }>} */
  const classifications = {};
  for (const outcome of outcomes) {
    classifications[outcome.id] = classifyOutcome(byId.get(outcome.id), outcome, today);
  }

  const declared = steps.length;
  const executed = outcomes.filter((o) => o.executed).length;
  const severityOf = (o) => classifications[o.id]?.severity;
  const passed = outcomes.filter((o) => severityOf(o) === PASS).length;
  const tolerated = outcomes.filter((o) => severityOf(o) === TOLERATED).length;
  const failed = outcomes.filter(
    (o) => severityOf(o) === FAILED || severityOf(o) === NOT_RUN,
  ).length;
  /** @type {string[]} */
  const violations = [];
  /** @type {string[]} */
  const notices = [];

  for (const outcome of outcomes) {
    const c = classifications[outcome.id];
    if (c?.severity === TOLERATED) {
      notices.push(
        `[tolerated-non-pass]  ${outcome.id} reported '${c.verdict}' (exit ${outcome.status}) — ` +
          `NOT a pass; ${c.note ?? 'tolerated by the manifest'}`,
      );
    } else if (c?.severity === FAILED && c.note !== undefined) {
      violations.push(`[expired-toleration]  ${outcome.id} — ${c.note}`);
    }
  }

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

  return {
    ok: violations.length === 0 && failed === 0,
    declared,
    executed,
    passed,
    tolerated,
    failed,
    violations,
    notices,
    classifications,
  };
}

/**
 * The end-of-run report. Every declared step appears, run or not, with its classified verdict.
 * A summary without classifications falls back to PASS, FAIL or NOT RUN from the exit status.
 */
export function renderSummary(outcomes, summary) {
  const lines = ['', '═'.repeat(72), 'npm run validate — aggregate result', '═'.repeat(72), ''];
  for (const outcome of outcomes) {
    const c = summary.classifications?.[outcome.id];
    const severity = c?.severity ?? (!outcome.executed ? NOT_RUN : outcome.passed ? PASS : FAILED);
    const label =
      severity === NOT_RUN
        ? 'NOT RUN'
        : severity === PASS
          ? 'PASS'
          : (c?.verdict ?? 'fail').toUpperCase();
    const suffix =
      severity === NOT_RUN
        ? ` (${outcome.error ?? 'never executed'})`
        : severity === PASS
          ? ''
          : ` (exit ${outcome.status}${c?.note ? `; ${c.note}` : ''})`;
    lines.push(`  ${label.padEnd(7)}  ${outcome.id.padEnd(30)} ${outcome.command}${suffix}`);
  }
  lines.push('');
  lines.push(
    `  ${summary.executed}/${summary.declared} declared steps executed · ` +
      `${summary.passed} passed · ` +
      `${summary.tolerated ?? 0} tolerated non-pass · ` +
      `${summary.failed} failed`,
  );
  for (const notice of summary.notices ?? []) lines.push(`  ${notice}`);
  for (const violation of summary.violations) lines.push(`  ${violation}`);
  lines.push('');
  lines.push(summary.ok ? 'validate: PASS' : 'validate: FAIL');
  return lines.join('\n');
}

const USAGE = `Usage: run-validate.mjs [--manifest <path>] [--json] [--list]

Runs EVERY step declared in ${DEFAULT_MANIFEST_PATH}, aggregating failures
instead of short-circuiting on the first one, and reports each step's verdict.

Options:
  --manifest <path>  Manifest to run (default: ${DEFAULT_MANIFEST_PATH})
  --list             Print the declared steps and exit without running them
  --json             Emit the machine-readable report on stdout
  --help             Show this message

Exit codes:
  0  Every declared step executed and either passed or hit a live advisory
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

/**
 * CLI body. An unreadable or malformed manifest returns 2, because a runner that knows of
 * no gates must not report that all gates passed.
 */
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
