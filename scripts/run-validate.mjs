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
 * ── Verdict fidelity (DR-7, task 078) ───────────────────────────────────────
 * The above fixed WHETHER a step ran. It did not fix WHAT the step's verdict
 * was: a step's outcome was `status === 0`, so `check-measured-premises.mjs`
 * printing `VERDICT: GAPS` while exiting 0 was aggregated as `PASS
 * measured-premises`, 9/9, exit 0. The reader saw a pass for a step that had
 * explicitly reported it was not one.
 *
 * A step may now DECLARE what its non-zero exit codes mean, in the manifest:
 *
 *     "outcomes": {
 *       "3": { "verdict": "gaps", "severity": "advisory",
 *              "issue": "#1789", "expires": "2026-11-30", "why": "…" }
 *     }
 *
 * The runner then renders that step's REAL verdict (`GAPS`, never `PASS`) and
 * the exit code follows the declared severity. Three properties make this a
 * gate rather than a loophole:
 *
 *   - exit 0 is not declarable. Pass means pass; a step cannot rename it.
 *   - an UNDECLARED non-zero code is a failure, as before. Toleration is
 *     opt-in and explicit, never inherited.
 *   - `expires` is mandatory on an advisory. Past it the toleration is dead and
 *     the step fails — a tolerated non-pass that nobody revisits is how "this
 *     is temporary" becomes permanent.
 *
 * Usage: run-validate.mjs [--manifest <path>] [--only <id>] [--json] [--list]
 *
 * Exit codes:
 *   0 = every declared step executed and either passed or hit a live advisory
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
 * @typedef {object} DeclaredOutcome
 * @property {string} verdict    Rendered in place of PASS/FAIL, e.g. `gaps`.
 * @property {'advisory' | 'fail'} severity
 * @property {string} [issue]    Tracking issue for the toleration.
 * @property {string} [expires]  `YYYY-MM-DD`; required when severity=advisory.
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
 * Validate a step's `outcomes` declaration.
 *
 * Every rule here is a way the declaration could become a silent pass, closed:
 * exit 0 is not declarable (pass is not renameable), an advisory with no
 * `expires` never dies, and a malformed block is a hard manifest error rather
 * than an ignored key — an `outcomes` typo that fell through would restore
 * exactly the "declared, enforced, cannot fail" shape this runner exists to
 * remove.
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

/** Today, UTC, as `YYYY-MM-DD`. */
function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Classify one executed step against its declared outcomes.
 *
 * The DEFAULTS are the fail-closed ones: exit 0 is a pass, a step that never
 * ran is `not-run`, and every other code is a failure unless the manifest says
 * otherwise. Toleration is a thing a step must ASK for, and an expired ask is
 * no ask at all.
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
  // Advisory — live only while unexpired. `expires` is the LAST tolerated day.
  const expires = declared.expires ?? '';
  if (expires <= today) {
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
 * Turn declared steps + outcomes into the run's verdict.
 *
 * `declared` comes from the manifest, never from a literal here.
 *
 * @param {ValidateStep[]} steps
 * @param {StepOutcome[]} outcomes
 * @param {string} [today] `YYYY-MM-DD`, injectable for the advisory-expiry tooth.
 * @returns {{ ok: boolean, declared: number, executed: number, passed: number, tolerated: number, failed: number, violations: string[], classifications: Record<string, { severity: string, verdict: string, note?: string }> }}
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
  /** Failing findings — each one makes `ok` false. */
  /** @type {string[]} */
  const violations = [];
  /** Non-failing findings that must still be SEEN. A tolerated step is
   *  reported, never hidden: the point of the declaration is that a reader of
   *  the aggregate learns the step did not pass. */
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
 * The end-of-run report. Every declared step appears, run or not — and every
 * step is labelled with the verdict IT computed, never with a verdict inferred
 * from the exit code alone.
 */
export function renderSummary(outcomes, summary) {
  const lines = ['', '═'.repeat(72), 'npm run validate — aggregate result', '═'.repeat(72), ''];
  for (const outcome of outcomes) {
    const c = summary.classifications?.[outcome.id];
    // Fall back to the pre-DR-7 two-valued rendering when no classification is
    // supplied (callers holding a summary from an older shape).
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

// ─── CLI ────────────────────────────────────────────────────────────────────

const USAGE = `Usage: run-validate.mjs [--manifest <path>] [--only <id>] [--json] [--list]

Runs EVERY step declared in ${DEFAULT_MANIFEST_PATH}, aggregating failures
instead of short-circuiting on the first one, and reports each step's verdict.

Options:
  --manifest <path>  Manifest to run (default: ${DEFAULT_MANIFEST_PATH})
  --only <id>        Run just this step (repeatable). A CI lane that hosts one
                     gate uses this so the step's declared outcome severity is
                     read from the manifest rather than restated in the workflow
  --list             Print the declared steps and exit without running them
  --json             Emit the machine-readable report on stdout
  --help             Show this message

Exit codes:
  0  Every declared step executed and either passed or hit a live advisory
  1  A step failed, the run truncated, or the denominator was empty
  2  Usage error, or the manifest could not be read (fail closed)`;

function parseArgs(argv) {
  const options = {
    manifest: DEFAULT_MANIFEST_PATH,
    only: [],
    json: false,
    list: false,
    help: false,
  };
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
    } else if (arg === '--only') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--only requires a step id');
      options.only.push(value);
      i += 1;
    } else throw new Error(`Unknown argument '${arg}'`);
  }
  return options;
}

/**
 * Narrow the declared steps to an explicit `--only` selection.
 *
 * An id that matches nothing is a HARD error rather than an empty run: a typo'd
 * or renamed step would otherwise select zero gates and — via the non-empty
 * denominator rule — look like a different failure than the one it is.
 *
 * @param {ValidateStep[]} steps
 * @param {string[]} only
 * @returns {{ steps: ValidateStep[] } | { error: string }}
 */
export function selectSteps(steps, only) {
  if (only.length === 0) return { steps };
  const known = new Set(steps.map((s) => s.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return {
      error:
        `--only named ${unknown.map((id) => JSON.stringify(id)).join(', ')}, which ` +
        `${unknown.length === 1 ? 'is not a declared step' : 'are not declared steps'}. ` +
        `Declared: ${steps.map((s) => s.id).join(', ')}`,
    };
  }
  const wanted = new Set(only);
  return { steps: steps.filter((s) => wanted.has(s.id)) };
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
  const selected = selectSteps(parsed.steps, options.only);
  if ('error' in selected) {
    process.stderr.write(`Error: ${selected.error}\n`);
    return 2;
  }
  const { steps } = selected;

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
