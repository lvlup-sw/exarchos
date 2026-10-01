/**
 * Kill fixtures for the governed advisories in {@link ADVISORY_REGISTRY}.
 * Each fixture is a seeded violation plus a seeded clean control. The real advisory must fire on the violation and stay silent on the control.
 * `verifyAdvisoryRatchet` reads the {@link KillProbeResult} values. It fails when a probe misses the violation or fires on the control.
 *
 * The `lint-inv6` probe spawns the real `tools/audit/gates/lint-inv6.mjs` against a seeded SKILL.md pair.
 * The `benchmark-regression` probe runs the real `check-benchmark-regression.sh` when `bash` and `jq` are present.
 * Otherwise it runs an in-process port, and it checks that the real script still holds its regression branch.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AdvisoryEntry, KillProbeResult } from './advisory-registry.js';
import { spawnCommandSync } from '../utils/process.js';

export interface RunKillProbeOptions {
  /** Absolute repo root (the directory containing `tools/audit/`). */
  readonly repoRoot: string;
  /** Override `bash` availability (tests). Auto-detected when omitted. */
  readonly hasBash?: boolean;
  /** Override `jq` availability (tests). Auto-detected when omitted. */
  readonly hasJq?: boolean;
}

/**
 * Return true when the named tool answers on PATH. Each spawn names its binary as a literal.
 * The portability gate rejects a variable binary in `src/`. A variable can resolve to a `.cmd` or `.ps1` shim,
 * which raw `spawnSync` cannot launch on Windows (CVE-2024-27980).
 */
function toolAvailable(tool: 'bash' | 'jq'): boolean {
  try {
    const r =
      tool === 'bash'
        ? spawnCommandSync('bash', ['--version'], { encoding: 'utf8', windowsHide: true })
        : spawnCommandSync('jq', ['--version'], { encoding: 'utf8', windowsHide: true });
    return !r.error && (r.status === 0 || typeof r.status === 'number');
  } catch {
    return false;
  }
}

interface LintFinding {
  readonly file: string;
  readonly rule: string;
}
interface LintOutput {
  readonly findings: readonly LintFinding[];
  readonly advisory: boolean;
}

/**
 * Run the real `lint-inv6.mjs` on a seeded SKILL.md pair.
 * The `flagged/` skill has a workflow-typed literal and no `workflow-type` in its frontmatter, so the lint must report a finding.
 * The `clean/` skill has the same literal and declares `metadata.workflow-type`, so the lint must report no finding.
 */
function probeLintInv6(advisory: AdvisoryEntry, opts: RunKillProbeOptions): KillProbeResult {
  const script = join(opts.repoRoot, 'tools', 'audit', 'gates', 'lint-inv6.mjs');
  if (!existsSync(script)) {
    return {
      advisoryId: advisory.id,
      killFixture: advisory.killFixture,
      firedOnViolation: false,
      firedOnClean: false,
      detail: `advisory control not found on disk: ${script}`,
    };
  }
  const dir = mkdtempSync(join(tmpdir(), 'advisory-inv6-'));
  try {
    const flaggedDir = join(dir, 'flagged');
    const cleanDir = join(dir, 'clean');
    mkdirSync(flaggedDir, { recursive: true });
    mkdirSync(cleanDir, { recursive: true });

    writeFileSync(
      join(flaggedDir, 'SKILL.md'),
      [
        '---',
        'name: flagged',
        'description: "seeded INV-6 leak"',
        '---',
        '',
        '# Flagged',
        '',
        'When you reach `feature/merge-pending`, rebase.',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(cleanDir, 'SKILL.md'),
      [
        '---',
        'name: clean',
        'description: "declared escape hatch"',
        'metadata:',
        '  workflow-type: feature',
        '---',
        '',
        '# Clean',
        '',
        'When you reach `feature/merge-pending`, rebase.',
        '',
      ].join('\n'),
      'utf8',
    );

    const r = spawnSync('node', [script, dir], {
      encoding: 'utf8',
      cwd: opts.repoRoot,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (r.error || typeof r.status !== 'number') {
      return {
        advisoryId: advisory.id,
        killFixture: advisory.killFixture,
        firedOnViolation: false,
        firedOnClean: false,
        detail: `could not spawn lint-inv6.mjs: ${r.error?.message ?? 'unknown'}`,
      };
    }
    let out: LintOutput;
    try {
      out = JSON.parse(r.stdout) as LintOutput;
    } catch {
      return {
        advisoryId: advisory.id,
        killFixture: advisory.killFixture,
        firedOnViolation: false,
        firedOnClean: false,
        detail: `lint-inv6.mjs did not emit parseable JSON`,
      };
    }
    const forFlagged = out.findings.filter((f) => f.file.includes('flagged'));
    const forClean = out.findings.filter((f) => f.file.includes('clean'));
    return {
      advisoryId: advisory.id,
      killFixture: advisory.killFixture,
      firedOnViolation: forFlagged.length >= 1,
      firedOnClean: forClean.length >= 1,
      detail: `flagged findings=${forFlagged.length}, clean findings=${forClean.length}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An in-process port of the regression comparison in `check-benchmark-regression.sh`. */
function detectsRegression(
  results: Record<string, Record<string, number>>,
  baselines: Record<string, Record<string, number>>,
  thresholdPct: number,
): boolean {
  for (const [op, metrics] of Object.entries(results)) {
    for (const [metric, measured] of Object.entries(metrics)) {
      const baseline = baselines[op]?.[metric];
      if (baseline === undefined || baseline === 0) continue;
      const changePct = ((measured - baseline) / baseline) * 100;
      if (changePct > thresholdPct) return true;
    }
  }
  return false;
}

/**
 * Run seeded results and baselines through `check-benchmark-regression.sh` with a 10% threshold.
 * The baseline for `latency.p95Ms` is 100. The violation measures 200 and must fail. The clean control measures 105 and must pass.
 * When `bash` and `jq` are present, the exit code of the real script decides.
 * Otherwise the port decides, and the violation counts as a fire only when the real script still holds its regression branch.
 */
function probeBenchmarkRegression(
  advisory: AdvisoryEntry,
  opts: RunKillProbeOptions,
): KillProbeResult {
  const script = join(opts.repoRoot, 'tools', 'audit', 'gates', 'check-benchmark-regression.sh');
  if (!existsSync(script)) {
    return {
      advisoryId: advisory.id,
      killFixture: advisory.killFixture,
      firedOnViolation: false,
      firedOnClean: false,
      detail: `advisory control not found on disk: ${script}`,
    };
  }

  const baselineMetrics = { latency: { p95Ms: 100 } };
  const violationMetrics = { latency: { p95Ms: 200 } };
  const cleanMetrics = { latency: { p95Ms: 105 } };
  const threshold = 10;

  const hasBash = opts.hasBash ?? toolAvailable('bash');
  const hasJq = opts.hasJq ?? toolAvailable('jq');

  if (hasBash && hasJq) {
    const dir = mkdtempSync(join(tmpdir(), 'advisory-bench-'));
    try {
      const baselinesPath = join(dir, 'baselines.json');
      const violationPath = join(dir, 'results-violation.json');
      const cleanPath = join(dir, 'results-clean.json');
      writeFileSync(baselinesPath, JSON.stringify({ baselines: baselineMetrics }), 'utf8');
      writeFileSync(violationPath, JSON.stringify(violationMetrics), 'utf8');
      writeFileSync(cleanPath, JSON.stringify(cleanMetrics), 'utf8');

      const run = (resultsPath: string): number => {
        const r = spawnSync(
          'bash',
          [
            script.replace(/\\/g, '/'),
            '--results',
            resultsPath.replace(/\\/g, '/'),
            '--baselines',
            baselinesPath.replace(/\\/g, '/'),
            '--threshold',
            String(threshold),
          ],
          { encoding: 'utf8', windowsHide: true },
        );
        return typeof r.status === 'number' ? r.status : -1;
      };
      const violationExit = run(violationPath);
      const cleanExit = run(cleanPath);
      return {
        advisoryId: advisory.id,
        killFixture: advisory.killFixture,
        firedOnViolation: violationExit === 1,
        firedOnClean: cleanExit === 1,
        detail: `real script exits: violation=${violationExit}, clean=${cleanExit}`,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const src = readFileSync(script, 'utf8');
  const structurallyIntact = src.includes('IS_REGRESSION') && src.includes('Result: FAIL');
  const firedOnViolation =
    structurallyIntact && detectsRegression(violationMetrics, baselineMetrics, threshold);
  const firedOnClean = detectsRegression(cleanMetrics, baselineMetrics, threshold);
  return {
    advisoryId: advisory.id,
    killFixture: advisory.killFixture,
    firedOnViolation,
    firedOnClean,
    detail:
      `bash/jq unavailable — evaluated via in-process port; ` +
      `real script regression branch ${structurallyIntact ? 'present' : 'MISSING'}`,
  };
}

type ProbeRunner = (advisory: AdvisoryEntry, opts: RunKillProbeOptions) => KillProbeResult;

const PROBE_BY_ADVISORY_ID: Record<string, ProbeRunner> = {
  'lint-inv6': probeLintInv6,
  'benchmark-regression': probeBenchmarkRegression,
};

/** Run a single advisory's kill fixture and return its {@link KillProbeResult}. */
export function runKillProbe(advisory: AdvisoryEntry, opts: RunKillProbeOptions): KillProbeResult {
  const runner = PROBE_BY_ADVISORY_ID[advisory.id];
  if (!runner) {
    return {
      advisoryId: advisory.id,
      killFixture: advisory.killFixture,
      firedOnViolation: false,
      firedOnClean: false,
      detail: `no kill-fixture probe implemented for advisory '${advisory.id}'`,
    };
  }
  return runner(advisory, opts);
}

/** Run every governed advisory's kill fixture. */
export function runAllKillProbes(
  registry: readonly AdvisoryEntry[],
  opts: RunKillProbeOptions,
): KillProbeResult[] {
  return registry.map((entry) => runKillProbe(entry, opts));
}
