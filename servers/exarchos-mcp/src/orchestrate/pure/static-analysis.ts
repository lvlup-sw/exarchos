/**
 * Static Analysis Gate
 *
 * Runs static analysis tools (lint, typecheck, quality-check) with structured
 * pass/fail output for the review workflow.
 *
 * Port of scripts/static-analysis-gate.sh. Retains external tool invocation
 * via a configurable RunCommandFn but moves orchestration, output parsing,
 * and result formatting to TypeScript.
 *
 * Exit code semantics (mapped to status field):
 *   'pass'  = all checks pass (warnings OK)
 *   'fail'  = errors found in one or more tools
 *   'skip'  = no applicable toolchain detected (inconclusive — distinct from
 *             'pass' so the gate cannot falsely-green repos with no
 *             recognized toolchain). When this status is returned, the
 *             `skipReason` field carries the reason code (currently only
 *             'no-toolchain'). See DR-4 in
 *             docs/plans/2026-05-04-v290-dogfood-bundle.md.
 *   'error' = usage error (missing repo root, no package.json)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectToolchain, BUILTIN_TOOLCHAINS } from '../../config/toolchains.js';

// ============================================================
// PUBLIC TYPES
// ============================================================

/** Result of running an external command. */
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Set when the command could not be SPAWNED at all (ENOENT/EACCES/…) — the
   * process never ran, so `exitCode`/`stdout` are not authoritative. Distinct
   * from a normal non-zero exit (the process ran and failed). Optional;
   * unset on a successful spawn. Consumed by the integration-suite gate to
   * separate a runner-spawn failure from a JSON-shape mismatch (#1537).
   */
  readonly spawnError?: string;
}

/**
 * Signature for the external command runner.
 *
 * Abstracted to allow mocking in tests while retaining real execFileSync
 * in production use.
 */
export type RunCommandFn = (
  cmd: string,
  args: readonly string[],
  options?: { cwd?: string }
) => CommandResult;

export interface StaticAnalysisInput {
  /** Repository root to analyze. */
  readonly repoRoot: string;
  /** Skip lint check. */
  readonly skipLint?: boolean;
  /** Skip typecheck. */
  readonly skipTypecheck?: boolean;
  /** External command runner (dependency injection). */
  readonly runCommand: RunCommandFn;
}

/**
 * Reason code for a 'skip' status. Currently only 'no-toolchain' is emitted
 * (no recognized project files in repoRoot). The union is open for future
 * skip reasons (e.g. 'all-checks-skipped-by-flag') without a breaking change.
 */
export type StaticAnalysisSkipReason = 'no-toolchain';

export interface StaticAnalysisResult {
  /**
   * Overall status.
   *
   * - 'pass'  — all applicable checks passed
   * - 'fail'  — one or more checks failed
   * - 'skip'  — no applicable toolchain detected (inconclusive); see
   *             `skipReason` for the reason code. Distinct from 'pass' so
   *             the gate does not falsely-green a repo with no recognized
   *             toolchain. See DR-4 in v2.9 dogfood plan.
   * - 'error' — usage error (missing/invalid repo root, etc.)
   */
  readonly status: 'pass' | 'fail' | 'skip' | 'error';
  /** Structured markdown report. */
  readonly output: string;
  /** Error message when status is 'error'. */
  readonly error?: string;
  /** Reason code when status is 'skip'. */
  readonly skipReason?: StaticAnalysisSkipReason;
  /** Number of checks that passed. */
  readonly passCount: number;
  /** Number of checks that failed. */
  readonly failCount: number;
  /** Detected project type (undefined if no recognized project). */
  readonly projectType?: string;
}

// ============================================================
// IMPORT-BOUNDARY LINT (SIV-3 Layer A, task 027)
// ============================================================
//
// The boundary-lint leg rides the static-analysis gate to enforce
// architectural import boundaries (e.g. "domain core must not import the IO
// facade"). It is Layer A of SIV-3: a *structural* boundary check on the
// module import graph.
//
// Decision (made at plan time): the leg is built on **dependency-cruiser**,
// NOT eslint-plugin-boundaries. This repo carries no ESLint infrastructure,
// so a standalone CLI (`npx depcruise --validate`) rides the gate cleanly
// without dragging an entire ESLint toolchain into the dependency tree. The
// rule set lives in a committed `.dependency-cruiser.cjs` at the repo root —
// the same file an author edits to add boundaries.
//
// Layer B (taint analysis — "no raw IO into core", a *dataflow* check) ships
// alongside, as `runRawIoTaint` below. dependency-cruiser only sees the import
// graph, not the flow of tainted values through it, so Layer B is a SEPARATE
// leg driven by a resolved taint engine (Semgrep) over a committed ruleset.
//
// Implementation decision (SIV-3B, #1529): the taint leg is driven by an
// EXTERNAL resolved engine (Semgrep), not a hand-rolled TypeScript-compiler AST
// walk. Rationale: (1) bundling the TS compiler into the shipped runtime to
// re-implement dataflow is disproportionate; (2) one engine (Semgrep) serves
// TS *and* the non-TS degrade the research names (CodeQL is the heavier
// alternative), so the guarantee is language-agnostic with a single per-runtime
// implementation (INV-4 parity) rather than a TS-only primary + a separate
// degrade; (3) the ruleset — not code — encodes BOTH halves of the invariant:
// (a) raw IO (`JSON.parse` / `response.json()` / `req.body` / `fs.read*`) whose
// result is not consumed by a registered parser, AND (b) out-of-band
// `as Brand` / `as any` casts downstream (Zod `.brand()` is compile-time-only;
// one stray cast defeats the scheme). The registered-parser surface is a
// resolved convention (`parsers: ['src/parse/**']`) referenced by the ruleset,
// not baked into this module.
//
// INV-4 degrade discipline: a repo with no `.dependency-cruiser.cjs` (or with
// dependency-cruiser absent from the toolchain) yields a SKIP leg, never a
// hard failure — exactly like the gate's "no lint script" SKIP. The leg only
// blocks when a real config is present AND a real violation is found.

/** Candidate config filenames for the boundary lint, in resolution order. */
const BOUNDARY_CONFIG_FILENAMES: readonly string[] = [
  '.dependency-cruiser.cjs',
  '.dependency-cruiser.js',
  '.dependency-cruiser.json',
  '.dependency-cruiser.mjs',
];

/** Report label for the boundary-lint leg. */
const BOUNDARY_LINT_NAME = 'Import boundaries';

export interface BoundaryLintInput {
  /** Repository root to scan for a `.dependency-cruiser.*` config. */
  readonly repoRoot: string;
  /** External command runner (dependency injection). */
  readonly runCommand: RunCommandFn;
  /**
   * Source dirs/files to validate. Defaults to `['.']` (whole repoRoot) — the
   * config's own `from`/`to` path rules narrow the actual surface, so passing
   * the repoRoot is sufficient and matches how authors run depcruise locally.
   */
  readonly sources?: readonly string[];
}

/** Verdict of the import-boundary leg. SKIP is the INV-4 advisory degrade. */
export interface BoundaryLintResult {
  readonly status: 'PASS' | 'FAIL' | 'SKIP';
  /** Human detail: the violation summary on FAIL, the skip reason on SKIP. */
  readonly detail?: string;
}

/**
 * Locate a `.dependency-cruiser.*` config in `repoRoot`. Returns the bare
 * filename (relative to repoRoot) of the first match, or null when none
 * exists. Detection is via a single directory listing so a test fs-mock that
 * stubs `readdirSync` to `[]` (the parity suite) correctly reports "no config"
 * even when `existsSync` is stubbed always-true.
 */
function findBoundaryConfig(repoRoot: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(repoRoot);
  } catch {
    return null;
  }
  const present = new Set(entries);
  return BOUNDARY_CONFIG_FILENAMES.find((name) => present.has(name)) ?? null;
}

/**
 * Run the dependency-cruiser import-boundary lint over `repoRoot`.
 *
 * - No `.dependency-cruiser.*` config present → SKIP (advisory; depcruise is
 *   NOT invoked).
 * - Config present, `depcruise --validate` exits 0 → PASS.
 * - Config present, `depcruise --validate` exits non-zero → FAIL with the
 *   violation summary in `detail`.
 *
 * The runner is invoked as `npx depcruise --validate <config> <sources...>`
 * with `cwd: repoRoot` — `npx` resolves the locally-installed binary (or skips
 * to PASS-equivalent SKIP if the runner cannot find it; a runner throw is
 * treated as a SKIP, not a FAIL, to honor the degrade discipline when the tool
 * is simply absent).
 */
export function runBoundaryLint(input: BoundaryLintInput): BoundaryLintResult {
  const { repoRoot, runCommand, sources = ['.'] } = input;

  const configName = findBoundaryConfig(repoRoot);
  if (configName === null) {
    return {
      status: 'SKIP',
      detail: `no ${BOUNDARY_CONFIG_FILENAMES[0]} in repo root`,
    };
  }

  let result: CommandResult;
  try {
    result = runCommand(
      'npx',
      ['depcruise', '--validate', configName, ...sources],
      { cwd: repoRoot },
    );
  } catch {
    // Tool absent / not resolvable → degrade to SKIP, never a hard failure.
    return { status: 'SKIP', detail: 'dependency-cruiser not available' };
  }

  if (result.exitCode === 0) {
    return { status: 'PASS' };
  }

  const detail =
    result.stderr.trim() ||
    result.stdout.trim() ||
    'dependency-cruiser reported a boundary violation';
  return { status: 'FAIL', detail };
}

// ============================================================
// BOUNDARY-PARSE TAINT (SIV-3 Layer B, #1529)
// ============================================================
//
// "No raw IO into the core": untrusted input must cross a registered parser
// before entering the domain core, and no out-of-band cast may forge a branded
// type downstream. This is a DATAFLOW concern dependency-cruiser cannot express
// (it sees imports, not value flow), so it rides its own resolved engine.
//
// The engine is Semgrep (resolved, not bundled — see the decision note above).
// The leg follows the exact INV-4 degrade discipline as Layer A: it only runs
// when a repo OPTS IN by committing a taint ruleset at a known path, and a
// missing ruleset OR a missing engine yields an advisory SKIP, never a hard
// FAIL. A repo that declares no parse boundary is simply not subject to the
// leg — keeping the gate noise-free for the majority of repos and never
// breaking a build that has not adopted the convention.

/** Candidate taint-ruleset filenames, in resolution order. */
const TAINT_RULESET_FILENAMES: readonly string[] = [
  '.semgrep/no-raw-io-into-core.yml',
  '.semgrep/no-raw-io-into-core.yaml',
];

/** Report label for the boundary-parse taint leg. */
const BOUNDARY_TAINT_NAME = 'Boundary IO taint';

export interface RawIoTaintInput {
  /** Repository root to scan for a taint ruleset. */
  readonly repoRoot: string;
  /** External command runner (dependency injection). */
  readonly runCommand: RunCommandFn;
  /**
   * Core source dirs to scan. Defaults to `['.']` — the ruleset's own `paths`
   * include/exclude narrows the real surface, so passing the repoRoot is
   * sufficient and matches how authors run semgrep locally.
   */
  readonly coreSources?: readonly string[];
}

/** Verdict of the boundary-parse taint leg. SKIP is the INV-4 advisory degrade. */
export interface RawIoTaintResult {
  readonly status: 'PASS' | 'FAIL' | 'SKIP';
  /** Human detail: the violation summary on FAIL, the skip reason on SKIP. */
  readonly detail?: string;
}

/**
 * Locate a taint ruleset in `repoRoot`. Returns the relative path of the first
 * match, or null when none exists. Detection mirrors `findBoundaryConfig`: a
 * single directory listing of the `.semgrep` dir, so an fs-mock that stubs
 * `readdirSync` correctly reports "no ruleset" without invoking the engine.
 */
function findTaintRuleset(repoRoot: string): string | null {
  for (const rel of TAINT_RULESET_FILENAMES) {
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(repoRoot, path.dirname(rel)));
    } catch {
      continue;
    }
    if (new Set(entries).has(path.basename(rel))) return rel;
  }
  return null;
}

/**
 * Run the boundary-parse taint leg over `repoRoot`.
 *
 * - No taint ruleset committed → SKIP (advisory; the engine is NOT invoked).
 * - Ruleset present, `semgrep` finds no violations (exit 0) → PASS.
 * - Ruleset present, `semgrep` reports findings (exit 1) → FAIL with the
 *   finding summary in `detail`.
 * - Ruleset present but the engine is absent or errors (throw / exit ≥2) →
 *   SKIP (degrade discipline: a missing/mis-resolving tool is inconclusive,
 *   never a hard failure).
 *
 * Invoked as `semgrep --error --quiet --config <ruleset> <coreSources...>` with
 * `cwd: repoRoot`. The `--error` flag makes findings exit non-zero so a FAIL is
 * unambiguous; `--quiet` keeps the report compact.
 */
export function runRawIoTaint(input: RawIoTaintInput): RawIoTaintResult {
  const { repoRoot, runCommand, coreSources = ['.'] } = input;

  const ruleset = findTaintRuleset(repoRoot);
  if (ruleset === null) {
    return {
      status: 'SKIP',
      detail: `no ${TAINT_RULESET_FILENAMES[0]} in repo`,
    };
  }

  let result: CommandResult;
  try {
    result = runCommand(
      'semgrep',
      ['--error', '--quiet', '--config', ruleset, ...coreSources],
      { cwd: repoRoot },
    );
  } catch {
    // Engine absent / not resolvable → degrade to SKIP, never a hard failure.
    return { status: 'SKIP', detail: 'semgrep not available' };
  }

  if (result.spawnError) {
    // The runner reports an unspawnable engine (ENOENT/EACCES) via `spawnError`
    // rather than throwing — when it does, `exitCode` is NOT authoritative, so a
    // coincidental `1` must not read as a boundary finding. Degrade to SKIP,
    // the same INV-4 discipline as the throw path above (and the contract the
    // integration-suite gate already honors, #1537).
    return {
      status: 'SKIP',
      detail: result.spawnError.trim() || 'semgrep not available',
    };
  }

  if (result.exitCode === 0) {
    return { status: 'PASS' };
  }

  // Exit 1 = findings (a real boundary violation) ⇒ FAIL. ANY OTHER non-zero
  // code is inconclusive, not a violation ⇒ degrade to SKIP (INV-4), the same
  // discipline as a missing tool: semgrep exit ≥2 is an engine/config error,
  // and a negative code is signal death (a SIGKILL'd engine) — neither is
  // evidence of a boundary violation, so neither may hard-FAIL the build.
  if (result.exitCode !== 1) {
    return {
      status: 'SKIP',
      detail: result.stderr.trim() || `semgrep inconclusive (exit ${result.exitCode})`,
    };
  }

  const detail =
    result.stdout.trim() ||
    result.stderr.trim() ||
    'semgrep reported a boundary-parse violation';
  return { status: 'FAIL', detail };
}

// ============================================================
// INTERNAL TYPES
// ============================================================

type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';

interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail?: string;
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Check if an npm script exists in the package.json scripts field.
 */
function hasNpmScript(packageJson: Record<string, unknown>, scriptName: string): boolean {
  const scripts = packageJson['scripts'];
  if (typeof scripts !== 'object' || scripts === null) return false;
  return scriptName in (scripts as Record<string, unknown>);
}

/**
 * Read and parse package.json from a directory.
 * Returns `{ packageJson }` on success or `{ error }` on failure.
 */
function readPackageJson(
  repoRoot: string,
): { packageJson: Record<string, unknown> } | { error: string } {
  const pkgPath = path.join(repoRoot, 'package.json');
  try {
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    return { packageJson: JSON.parse(raw) as Record<string, unknown> };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to read ${pkgPath}: ${message}` };
  }
}

// ============================================================
// CHECK RUNNERS
// ============================================================

function runNpmCheck(
  name: string,
  scriptName: string,
  packageJson: Record<string, unknown>,
  repoRoot: string,
  runCommand: RunCommandFn,
  skip: boolean
): CheckResult {
  if (skip) {
    return { name, status: 'SKIP', detail: `--skip-${scriptName.replace('quality-', '')}` };
  }

  if (!hasNpmScript(packageJson, scriptName)) {
    return { name, status: 'SKIP', detail: `no '${scriptName}' script in package.json` };
  }

  try {
    const result = runCommand('npm', ['run', scriptName], { cwd: repoRoot });
    if (result.exitCode === 0) {
      return { name, status: 'PASS' };
    }
    const detail =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `npm run ${scriptName} failed`;
    return { name, status: 'FAIL', detail };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: 'FAIL', detail: message };
  }
}

// ============================================================
// PROJECT TYPE DETECTION
// ============================================================

type ProjectType = 'Node.js' | '.NET' | 'Rust' | 'Go';

/**
 * Toolchain ids this gate has check-runners for, mapped to their report label.
 * Detection itself is delegated to the shared registry (single source of truth
 * for markers — this is where `.slnx`/`.sln` are recognized, #1507). The
 * registry detects many more toolchains; this gate only *runs checks* for the
 * four it has runners for and SKIPs the rest (honest no-toolchain).
 */
const SUPPORTED_TOOLCHAINS: Readonly<Record<string, ProjectType>> = {
  node: 'Node.js',
  dotnet: '.NET',
  rust: 'Rust',
  go: 'Go',
};

/** Markers (registry-sourced) for the gate's supported toolchains, for the SKIP message. */
function supportedMarkers(): string[] {
  return Object.keys(SUPPORTED_TOOLCHAINS).flatMap(
    (id) => BUILTIN_TOOLCHAINS.find((t) => t.id === id)?.markers ?? [],
  );
}

/**
 * Detect project type via the shared toolchain registry, narrowed to the
 * toolchains this gate can actually check. Returns undefined when nothing is
 * detected or the detected toolchain has no runner here.
 */
function detectProjectType(repoRoot: string): ProjectType | undefined {
  const toolchain = detectToolchain(repoRoot);
  if (toolchain && toolchain.id in SUPPORTED_TOOLCHAINS) {
    return SUPPORTED_TOOLCHAINS[toolchain.id];
  }
  return undefined;
}

// ============================================================
// GENERIC CHECK RUNNER
// ============================================================

function runGenericCheck(
  name: string,
  cmd: string,
  args: readonly string[],
  repoRoot: string,
  runCommand: RunCommandFn,
  skip: boolean,
): CheckResult {
  if (skip) {
    return { name, status: 'SKIP', detail: 'skipped by flag' };
  }

  try {
    const result = runCommand(cmd, args, { cwd: repoRoot });
    if (result.exitCode === 0) {
      return { name, status: 'PASS' };
    }
    const detail = result.stderr.trim() || result.stdout.trim() || `${cmd} ${args.join(' ')} failed`;
    return { name, status: 'FAIL', detail };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: 'FAIL', detail: message };
  }
}

// ============================================================
// PLATFORM-SPECIFIC CHECK RUNNERS
// ============================================================

function runNodeChecks(
  repoRoot: string,
  runCommand: RunCommandFn,
  skipLint: boolean,
  skipTypecheck: boolean,
): CheckResult[] {
  const pkgResult = readPackageJson(repoRoot);
  if ('error' in pkgResult) {
    return [{ name: 'package.json', status: 'FAIL', detail: pkgResult.error }];
  }
  const { packageJson } = pkgResult;

  return [
    runNpmCheck('Lint', 'lint', packageJson, repoRoot, runCommand, skipLint),
    runNpmCheck('Typecheck', 'typecheck', packageJson, repoRoot, runCommand, skipTypecheck),
    runNpmCheck('Quality check', 'quality-check', packageJson, repoRoot, runCommand, false),
  ];
}

function runDotnetChecks(
  repoRoot: string,
  runCommand: RunCommandFn,
  skipLint: boolean,
  skipTypecheck: boolean,
): CheckResult[] {
  return [
    runGenericCheck('Build', 'dotnet', ['build', '--no-restore', '-warnaserror'], repoRoot, runCommand, skipLint && skipTypecheck),
  ];
}

function runGoChecks(
  repoRoot: string,
  runCommand: RunCommandFn,
  skipLint: boolean,
  skipTypecheck: boolean,
): CheckResult[] {
  return [
    runGenericCheck('Vet', 'go', ['vet', './...'], repoRoot, runCommand, skipLint),
  ];
}

function runRustChecks(
  repoRoot: string,
  runCommand: RunCommandFn,
  skipLint: boolean,
  skipTypecheck: boolean,
): CheckResult[] {
  return [
    runGenericCheck('Check', 'cargo', ['check'], repoRoot, runCommand, skipTypecheck),
    runGenericCheck('Clippy', 'cargo', ['clippy', '--', '-D', 'warnings'], repoRoot, runCommand, skipLint),
  ];
}

// ============================================================
// MAIN FUNCTION
// ============================================================

export function runStaticAnalysis(input: StaticAnalysisInput): StaticAnalysisResult {
  const { repoRoot, skipLint = false, skipTypecheck = false, runCommand } = input;

  if (!repoRoot || repoRoot.trim().length === 0) {
    return {
      status: 'error',
      output: '',
      error: 'Missing repoRoot',
      passCount: 0,
      failCount: 0,
    };
  }

  // Validate repoRoot exists on disk
  try {
    if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
      return {
        status: 'error',
        output: '',
        error: `Invalid repoRoot: ${repoRoot} does not exist or is not a directory`,
        passCount: 0,
        failCount: 0,
      };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      output: '',
      error: `Invalid repoRoot: ${message}`,
      passCount: 0,
      failCount: 0,
    };
  }

  // Detect project type
  const projectType = detectProjectType(repoRoot);

  if (!projectType) {
    // T-10 / DR-4: no recognized toolchain returns 'skip' (inconclusive),
    // NOT 'pass'. A pass would falsely-green any repo missing a toolchain
    // marker. Callers (handler + convergence view) translate this into a
    // skipped/inconclusive gate result rather than a passing one.
    const output = [
      '## Static Analysis Report',
      '',
      `**Repository:** \`${repoRoot}\``,
      '',
      `- **SKIP**: No recognized project type (none of: ${supportedMarkers().join(', ')})`,
      '',
      '---',
      '',
      '**Result: SKIP** (no applicable toolchain detected)',
    ].join('\n');

    return {
      status: 'skip',
      output,
      skipReason: 'no-toolchain',
      passCount: 0,
      failCount: 0,
      projectType: undefined,
    };
  }

  // Run platform-specific checks
  let checks: CheckResult[];
  switch (projectType) {
    case 'Node.js':
      checks = runNodeChecks(repoRoot, runCommand, skipLint, skipTypecheck);
      break;
    case '.NET':
      checks = runDotnetChecks(repoRoot, runCommand, skipLint, skipTypecheck);
      break;
    case 'Go':
      checks = runGoChecks(repoRoot, runCommand, skipLint, skipTypecheck);
      break;
    case 'Rust':
      checks = runRustChecks(repoRoot, runCommand, skipLint, skipTypecheck);
      break;
  }

  // SIV-3 Layer A (task 027): fold the import-boundary leg into the report
  // ONLY when a `.dependency-cruiser.*` config is actually present. An absent
  // config produces an advisory SKIP from runBoundaryLint that we deliberately
  // do NOT append — the leg simply does not apply to repos that declare no
  // boundaries, keeping the report free of noise (and preserving the gate's
  // existing output for the overwhelming majority of repos). When a config IS
  // present, the leg's PASS/FAIL is a first-class check counted in the totals.
  const boundary = runBoundaryLint({ repoRoot, runCommand });
  if (boundary.status !== 'SKIP') {
    checks.push({
      name: BOUNDARY_LINT_NAME,
      status: boundary.status,
      ...(boundary.detail ? { detail: boundary.detail } : {}),
    });
  }

  // SIV-3 Layer B (#1529): fold the boundary-parse taint leg in on the same
  // terms as Layer A — only when a repo has opted in with a committed taint
  // ruleset. An absent ruleset (or an unresolved engine) yields an advisory
  // SKIP we deliberately do NOT append, so the leg is invisible to repos that
  // have not adopted the parse-at-edge convention and never breaks their build.
  const taint = runRawIoTaint({ repoRoot, runCommand });
  if (taint.status !== 'SKIP') {
    checks.push({
      name: BOUNDARY_TAINT_NAME,
      status: taint.status,
      ...(taint.detail ? { detail: taint.detail } : {}),
    });
  }

  // Tally results
  let passCount = 0;
  let failCount = 0;

  for (const check of checks) {
    if (check.status === 'PASS') passCount++;
    if (check.status === 'FAIL') failCount++;
  }

  // Build structured output
  const outputLines: string[] = [
    '## Static Analysis Report',
    '',
    `**Repository:** \`${repoRoot}\``,
    `**Project type:** ${projectType}`,
    '',
  ];

  for (const check of checks) {
    if (check.detail) {
      outputLines.push(`- **${check.status}**: ${check.name} — ${check.detail}`);
    } else {
      outputLines.push(`- **${check.status}**: ${check.name}`);
    }
  }

  outputLines.push('');

  const total = passCount + failCount;

  outputLines.push('---');
  outputLines.push('');

  if (failCount === 0) {
    outputLines.push(`**Result: PASS** (${passCount}/${total} checks passed)`);
  } else {
    outputLines.push(`**Result: FAIL** (${failCount}/${total} checks failed)`);
  }

  const output = outputLines.join('\n');

  return {
    status: failCount === 0 ? 'pass' : 'fail',
    output,
    passCount,
    failCount,
    projectType,
  };
}
