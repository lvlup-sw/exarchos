#!/usr/bin/env node
/**
 * Coverage non-regression ratchet.
 *
 * It compares the totals in `coverage-summary.json` with the baseline in
 * `tools/audit/coverage-baseline.json`, for `lines`, `statements`, `functions`
 * and `branches`. A metric regresses when `observed < baseline - epsilon`, and
 * `epsilon = max(spread, 0.1)` percentage points. The code applies the floor,
 * so a baseline with a zero spread cannot disarm the ratchet.
 *
 * It fails closed on a missing or malformed summary or baseline. A baseline
 * must record at least three distinct CI run-ids and a `spread` per metric.
 *
 * Usage: `check-coverage-ratchet.mjs [--summary <path>] [--baseline <path>] [--observe]`.
 * Exit 0 is a pass, 1 is a regression, and 2 is a fail-closed or usage error.
 * `--observe` computes the same verdict, logs it, and always exits 0.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const DEFAULT_SUMMARY = path.join(
  REPO_ROOT,
  'coverage',
  'coverage-summary.json',
);
/**
 * The baseline sits with the other audit oracles under `tools/audit/`, not
 * beside the code it measures. A baseline that moves with the code can silently
 * stop governing.
 */
const DEFAULT_BASELINE = path.join(REPO_ROOT, 'tools', 'audit', 'coverage-baseline.json');

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

/** Reads and parses a JSON file. It throws `RatchetFailClosed` with the path and the reason. */
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

/** Validates the shape of the coverage summary and returns `{ metric: pct }`. */
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
 * Validates the baseline provenance and returns `{ metric: { pct, spread } }`.
 * It rejects a baseline with fewer than three distinct run-ids, because one run
 * carries no cross-run variance. It also rejects a metric with no measured
 * `spread`.
 */
function extractBaselineProvenance(baseline, baselinePath) {
  if (!baseline || typeof baseline !== 'object') {
    throw new RatchetFailClosed(`baseline at ${baselinePath} is not a JSON object`);
  }

  const runIds = baseline.runIds;
  if (
    !Array.isArray(runIds) ||
    !runIds.every((id) => typeof id === 'string' && id.trim() !== '')
  ) {
    throw new RatchetFailClosed(
      `baseline at ${baselinePath} is missing run-ids (no CI provenance) — rejecting per DR-10; a ` +
        'coverage baseline must record the originating CI run-ids',
    );
  }
  const distinctRunIds = new Set(runIds.map((id) => id.trim()));
  if (distinctRunIds.size < 3) {
    throw new RatchetFailClosed(
      `baseline at ${baselinePath} records only ${distinctRunIds.size} distinct run-id(s) ` +
        `(${runIds.length} entr${runIds.length === 1 ? 'y' : 'ies'} total) — rejecting per DR-10/DR-5; a ` +
        'coverage baseline must be measured across at least 3 distinct CI runs so its variance is real, ' +
        'not a single-run guess',
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

/** Computes the verdict. It throws on a regression or a fail-closed condition, and never exits. */
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
