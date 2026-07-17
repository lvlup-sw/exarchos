#!/usr/bin/env node
/**
 * check-coverage-ratchet — coverage non-regression ratchet (DR-5, DR-10).
 *
 * Compares `coverage-summary.json` totals (produced by the vitest `v8`
 * provider's `json-summary` reporter — see `servers/exarchos-mcp/vitest.config.ts`)
 * against a checked-in baseline (`servers/exarchos-mcp/coverage-baseline.json`),
 * one comparison per standard v8/istanbul metric (`lines`, `statements`,
 * `functions`, `branches`).
 *
 * Epsilon is MEASURED, then FLOORED: the baseline records a per-metric
 * `spread` (the observed variance across the ≥3 CI runs used to build it —
 * task 009's job, not this script's). This script derives
 * `epsilon_m = max(spread_m, 0.1 percentage points)` itself, at comparison
 * time — the floor is enforced in code, never trusted as a pre-baked baseline
 * field, so a baseline that (incorrectly) recorded a zero epsilon can never
 * disarm the ratchet. A metric regresses when
 * `observed_m < baseline_m - epsilon_m`.
 *
 * FAIL CLOSED (DR-10) — never skip-as-pass:
 *   - `coverage-summary.json` missing, unreadable, unparseable, or missing
 *     its `total` aggregate / a metric's numeric `pct` → fail-closed.
 *   - the baseline missing, unreadable, unparseable, missing `runIds`
 *     provenance (empty/absent), or missing a metric's measured `spread`
 *     (variance) → fail-closed. A baseline without provenance cannot govern
 *     the ratchet.
 * Every failure message names the artifact (path) and the reason.
 *
 * `--observe` mode (the DR-7-symmetric soak-window flag): the SAME verdict is
 * computed — regression, fail-closed, or pass — but the process always exits
 * 0. It logs what the blocking verdict would have been instead of enforcing
 * it. This is what lets task 007 wire this step into CI (with the observe
 * flag) before task 009 has captured the live baseline: an as-yet-absent
 * baseline degrades to an observed, logged fail-closed condition rather than
 * a broken build.
 *
 *   Exit 0 — no metric regressed beyond its floored epsilon (blocking mode),
 *            OR `--observe` mode (always, regardless of verdict).
 *   Exit 1 — a metric regressed beyond its floored epsilon (blocking mode).
 *   Exit 2 — fail-closed: missing/unparseable summary or baseline, or a
 *            baseline missing run-id/variance provenance (blocking mode).
 *
 * Flags:
 *   --summary <path>   Path to coverage-summary.json. Default
 *                       `servers/exarchos-mcp/coverage/coverage-summary.json`
 *                       (repo-relative).
 *   --baseline <path>  Path to the baseline JSON. Default
 *                       `servers/exarchos-mcp/coverage-baseline.json`.
 *   --observe          Log the verdict; always exit 0.
 *   --help             Show usage.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_SUMMARY = path.join(
  REPO_ROOT,
  'servers',
  'exarchos-mcp',
  'coverage',
  'coverage-summary.json',
);
const DEFAULT_BASELINE = path.join(REPO_ROOT, 'servers', 'exarchos-mcp', 'coverage-baseline.json');

const EXIT_PASS = 0;
const EXIT_REGRESSION = 1;
const EXIT_FAILCLOSED = 2;

const METRICS = ['lines', 'statements', 'functions', 'branches'];
const EPSILON_FLOOR_PP = 0.1;

class RatchetFailClosed extends Error {}
class RatchetRegression extends Error {
  constructor(message, rows) {
    super(message);
    this.rows = rows;
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function printUsage() {
  process.stderr.write(
    'Usage: check-coverage-ratchet.mjs [--summary <path>] [--baseline <path>] [--observe] [--help]\n',
  );
}

function usageFail(msg) {
  process.stderr.write(`check-coverage-ratchet: ${msg}\n`);
  printUsage();
  process.exit(EXIT_FAILCLOSED);
}

function parseArgs(argv) {
  const args = { summary: DEFAULT_SUMMARY, baseline: DEFAULT_BASELINE, observe: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(EXIT_PASS);
    } else if (arg === '--summary') {
      const value = argv[++i];
      if (!value) usageFail('--summary requires a path argument');
      args.summary = path.resolve(value);
    } else if (arg === '--baseline') {
      const value = argv[++i];
      if (!value) usageFail('--baseline requires a path argument');
      args.baseline = path.resolve(value);
    } else if (arg === '--observe') {
      args.observe = true;
    } else {
      usageFail(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

// ── artifact loading (fail-closed, names the artifact + reason) ─────────────

/** Read + JSON.parse a file, throwing RatchetFailClosed naming artifact + reason. */
function readJsonOrFailClosed(filePath, label) {
  if (!existsSync(filePath)) {
    throw new RatchetFailClosed(`${label} not found at ${filePath}`);
  }
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new RatchetFailClosed(`${label} could not be read at ${filePath}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new RatchetFailClosed(`${label} at ${filePath} is unparseable JSON: ${err.message}`);
  }
}

/** Validate coverage-summary.json shape; return { metric: pct }. */
function extractSummaryTotals(summary, summaryPath) {
  if (!summary || typeof summary !== 'object' || !summary.total || typeof summary.total !== 'object') {
    throw new RatchetFailClosed(
      `coverage-summary.json at ${summaryPath} is missing its "total" aggregate — reporter contract ` +
        'changed, or this is not a coverage-summary artifact',
    );
  }
  const totals = {};
  for (const metric of METRICS) {
    const entry = summary.total[metric];
    if (!entry || typeof entry.pct !== 'number' || Number.isNaN(entry.pct)) {
      throw new RatchetFailClosed(
        `coverage-summary.json at ${summaryPath} is missing a numeric "total.${metric}.pct" — cannot ` +
          'ratchet an incomplete summary',
      );
    }
    totals[metric] = entry.pct;
  }
  return totals;
}

/**
 * Validate baseline provenance (DR-10: reject a baseline missing run-ids or
 * variance) and return { metric: { pct, spread } }.
 */
function extractBaselineProvenance(baseline, baselinePath) {
  if (!baseline || typeof baseline !== 'object') {
    throw new RatchetFailClosed(`baseline at ${baselinePath} is not a JSON object`);
  }

  const runIds = baseline.runIds;
  if (
    !Array.isArray(runIds) ||
    runIds.length === 0 ||
    !runIds.every((id) => typeof id === 'string' && id.trim() !== '')
  ) {
    throw new RatchetFailClosed(
      `baseline at ${baselinePath} is missing run-ids (no CI provenance) — rejecting per DR-10; a ` +
        'coverage baseline must record the originating CI run-ids',
    );
  }

  if (!baseline.metrics || typeof baseline.metrics !== 'object') {
    throw new RatchetFailClosed(`baseline at ${baselinePath} is missing its "metrics" block`);
  }

  const metrics = {};
  for (const metric of METRICS) {
    const entry = baseline.metrics[metric];
    if (!entry || typeof entry.pct !== 'number' || Number.isNaN(entry.pct)) {
      throw new RatchetFailClosed(
        `baseline at ${baselinePath} is missing a numeric "metrics.${metric}.pct" — cannot compare`,
      );
    }
    if (typeof entry.spread !== 'number' || Number.isNaN(entry.spread) || entry.spread < 0) {
      throw new RatchetFailClosed(
        `baseline at ${baselinePath} is missing measured variance ("metrics.${metric}.spread") — ` +
          'rejecting per DR-10; a provenance-less baseline (no variance) cannot govern the ratchet',
      );
    }
    metrics[metric] = { pct: entry.pct, spread: entry.spread };
  }
  return metrics;
}

// ── comparison ────────────────────────────────────────────────────────────

function compare(observedTotals, baselineMetrics) {
  const rows = [];
  let regressed = false;
  for (const metric of METRICS) {
    const observed = observedTotals[metric];
    const { pct: baselinePct, spread } = baselineMetrics[metric];
    const epsilon = Math.max(spread, EPSILON_FLOOR_PP);
    const delta = observed - baselinePct;
    const isRegression = delta < -epsilon;
    if (isRegression) regressed = true;
    rows.push({ metric, observed, baselinePct, spread, epsilon, delta, isRegression });
  }
  return { rows, regressed };
}

function formatReport(rows) {
  const header = 'metric        baseline   observed      delta   epsilon   status';
  const lines = [header];
  for (const r of rows) {
    const status = r.isRegression ? 'FAIL' : 'ok';
    const sign = r.delta >= 0 ? '+' : '';
    lines.push(
      `${r.metric.padEnd(13)} ${r.baselinePct.toFixed(2).padStart(8)}   ${r.observed
        .toFixed(2)
        .padStart(8)}   ${`${sign}${r.delta.toFixed(2)}`.padStart(7)}   ${r.epsilon
        .toFixed(2)
        .padStart(7)}   ${status}`,
    );
  }
  return lines.join('\n');
}

// ── verdict computation (side-effect free — throws, never exits) ───────────

function computeVerdict(args) {
  const summary = readJsonOrFailClosed(args.summary, 'coverage-summary.json');
  const observedTotals = extractSummaryTotals(summary, args.summary);

  const baseline = readJsonOrFailClosed(args.baseline, 'coverage-baseline.json');
  const baselineMetrics = extractBaselineProvenance(baseline, args.baseline);

  const { rows, regressed } = compare(observedTotals, baselineMetrics);
  const report = formatReport(rows);

  if (regressed) {
    throw new RatchetRegression(
      `coverage regressed beyond its floored epsilon on one or more metrics:\n${report}`,
      rows,
    );
  }
  return report;
}

// ── CLI driver ───────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);
  try {
    const report = computeVerdict(args);
    process.stdout.write(`check-coverage-ratchet: PASS\n${report}\n`);
    process.exit(EXIT_PASS);
  } catch (err) {
    if (err instanceof RatchetRegression) {
      if (args.observe) {
        process.stdout.write(
          'check-coverage-ratchet: OBSERVE — a regression would FAIL blocking mode (not enforced ' +
            `during the DR-7-symmetric soak window):\n${err.message}\n`,
        );
        process.exit(EXIT_PASS);
      }
      process.stderr.write(`check-coverage-ratchet: FAIL — ${err.message}\n`);
      process.exit(EXIT_REGRESSION);
    }
    if (err instanceof RatchetFailClosed) {
      if (args.observe) {
        process.stdout.write(
          'check-coverage-ratchet: OBSERVE — a fail-closed condition was encountered (not enforced ' +
            `during the soak window): ${err.message}\n`,
        );
        process.exit(EXIT_PASS);
      }
      process.stderr.write(`check-coverage-ratchet: FAIL CLOSED — ${err.message}\n`);
      process.exit(EXIT_FAILCLOSED);
    }
    throw err;
  }
}

main();
