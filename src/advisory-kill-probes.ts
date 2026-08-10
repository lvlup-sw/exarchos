/**
 * advisory-kill-probes — the executable kill fixtures for the governed
 * advisories in {@link ADVISORY_REGISTRY} (P07-07).
 *
 * A kill fixture is a SEEDED VIOLATION plus a SEEDED CLEAN CONTROL: running the
 * real advisory against them must FIRE on the violation and stay SILENT on the
 * control. That discriminating pair is the one real guarantee that an advisory
 * is not theatre. `verifyAdvisoryRatchet` (in `advisory-registry.ts`) consumes
 * the {@link KillProbeResult}s these probes produce and fails if any registered
 * advisory's kill fixture no longer fires.
 *
 * The probes run the REAL advisory control wherever that is portable:
 *   - `lint-inv6`             — spawns the real `scripts/lint-inv6.mjs` (Node,
 *     fully portable) against a seeded SKILL.md pair.
 *   - `benchmark-regression`  — runs the real `scripts/check-benchmark-regression.sh`
 *     when `bash` + `jq` are present; otherwise it evaluates the same seeded
 *     (results, baselines) fixtures with a faithful in-process port AND
 *     structurally asserts the real script still declares its regression branch,
 *     so a gutted/deleted advisory is still caught. (The real script hard-requires
 *     `jq`, which is absent on the Windows dev box; on CI Linux the real script
 *     runs. See the module report for the jq portability follow-up.)
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AdvisoryEntry, KillProbeResult } from './advisory-registry.js';

// ─── Options ─────────────────────────────────────────────────────────────────

export interface RunKillProbeOptions {
  /** Absolute repo root (the directory containing `scripts/`). */
  readonly repoRoot: string;
  /** Override `bash` availability (tests). Auto-detected when omitted. */
  readonly hasBash?: boolean;
  /** Override `jq` availability (tests). Auto-detected when omitted. */
  readonly hasJq?: boolean;
}

// ─── Tool detection ──────────────────────────────────────────────────────────

/**
 * Whether an external tool answers on PATH.
 *
 * The bin is a LITERAL at each spawn rather than a parameter. A resolved command
 * variable can land on a `.cmd`/`.ps1` shim that raw `spawnSync` cannot launch
 * on Windows (CVE-2024-27980), which is why the portability gate refuses a
 * variable bin in shipped `src/` at all — and this module compiles into `dist/`
 * like the rest of it. `bash` and `jq` are real executables wherever this probe
 * runs, so naming them directly is both correct and legible to the gate.
 */
function toolAvailable(tool: 'bash' | 'jq'): boolean {
  try {
    const r =
      tool === 'bash'
        ? spawnSync('bash', ['--version'], { encoding: 'utf8', windowsHide: true })
        : spawnSync('jq', ['--version'], { encoding: 'utf8', windowsHide: true });
    return !r.error && typeof r.status === 'number';
  } catch {
    return false;
  }
}

// ─── lint-inv6 kill fixture ──────────────────────────────────────────────────

interface LintFinding {
  readonly file: string;
  readonly rule: string;
}
interface LintOutput {
  readonly findings: readonly LintFinding[];
  readonly advisory: boolean;
}

/**
 * Seeded SKILL.md pair, run through the REAL `scripts/lint-inv6.mjs`:
 *   - `flagged/`: a workflow-typed literal in the body, NO `workflow-type` in
 *     frontmatter → the lint MUST report ≥1 finding (fires);
 *   - `clean/`:   the same literal, but with `metadata.workflow-type` declared →
 *     the lint MUST report 0 findings (silent).
 */
function probeLintInv6(advisory: AdvisoryEntry, opts: RunKillProbeOptions): KillProbeResult {
  const script = join(opts.repoRoot, 'scripts', 'lint-inv6.mjs');
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

// ─── benchmark-regression kill fixture ───────────────────────────────────────

/** A faithful in-process port of the script's core regression comparison. */
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
 * Seeded (results, baselines) fixtures for `check-benchmark-regression.sh`:
 *   - violation: `latency.p95Ms` measured 200 vs baseline 100 (+100% > 10%)  → FAIL;
 *   - clean:     `latency.p95Ms` measured 105 vs baseline 100 (+5% ≤ 10%)    → PASS.
 *
 * When bash + jq are present, the REAL script decides via its exit code. When
 * they are not, the port decides, guarded by a structural assertion that the
 * real script still contains its regression branch — so the probe cannot pass
 * against a deleted or gutted advisory.
 */
function probeBenchmarkRegression(
  advisory: AdvisoryEntry,
  opts: RunKillProbeOptions,
): KillProbeResult {
  const script = join(opts.repoRoot, 'scripts', 'check-benchmark-regression.sh');
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

  // Portable fallback: port + structural binding to the real advisory.
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

// ─── Dispatch ────────────────────────────────────────────────────────────────

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
