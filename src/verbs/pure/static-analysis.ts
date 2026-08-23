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
 *   'pass'  = EVERY applicable check ran and passed (warnings OK)
 *   'fail'  = errors found in one or more tools
 *   'skip'  = the gate is inconclusive. Two reasons produce it:
 *             'no-toolchain'        — nothing this gate can run checks for. The
 *                                     registry recognised no toolchain at all,
 *                                     or it recognised one this gate has no
 *                                     runner for. The report says which.
 *             'constituent-skipped' — a toolchain WAS detected and at least one
 *                                     constituent check did not run (missing
 *                                     npm script, a --skip-* flag, a command
 *                                     that could not be launched, or a
 *                                     toolchain that assembled no runnable leg
 *                                     at all) while no check failed. The
 *                                     dimension is DEGRADED, never PASS: a
 *                                     check that never ran is not evidence that
 *                                     it would pass.
 *             The `skipReason` field carries the reason code.
 *   'error' = usage error (missing repo root, no package.json, unreadable
 *             `.exarchos.yml`)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCommandSync } from '../../utils/process.js';
import { loadExarchosConfig } from '../../config/load-exarchos-config.js';
import {
  detectToolchain,
  toolchainFromConfig,
  BUILTIN_TOOLCHAINS,
  type ConfigToolchain,
  type Toolchain,
} from '../../config/toolchains.js';

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
 *
 * `timeoutMs` is a REQUIREMENT on the runner, not a hint: a toolchain command
 * that never returns must not become a gate that never returns. An
 * implementation that cannot bound the wall clock should report the expiry the
 * same way it reports an unspawnable binary — through `spawnError`, which says
 * `exitCode` is not authoritative — because a command that was killed produced
 * no evidence either way and must not read as a failure.
 */
export type RunCommandFn = (
  cmd: string,
  args: readonly string[],
  options?: { cwd?: string; timeoutMs?: number }
) => CommandResult;

/**
 * Wall-clock bound every command this gate spawns is given.
 *
 * Ten minutes is chosen to sit above a cold full-repository build or typecheck
 * on a large governed repository and well below any human's patience for a
 * gate that has stopped making progress. It is a single declared value rather
 * than a per-call literal so the bound is one fact a reader can find and
 * change, and so a spawn site that forgot it is visible as an omission.
 */
export const CHECK_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Output ceiling for one check, in bytes.
 *
 * Node's default is a megabyte, which a failing lint or typecheck run over a
 * large repository exceeds routinely — and overflowing it kills the child, so
 * the very run that had the most to say is the one whose verdict is lost. The
 * ceiling is raised to where only a runaway can reach it; the transcript is
 * capped for the reader separately (see the fail-detail cap below), which is a
 * presentation concern and not a reason to stop reading the tool's output.
 */
export const CHECK_COMMAND_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Exit code reported alongside a `spawnError`. The field's whole point is that
 * the number is not authoritative, so this is a placeholder in the
 * command-not-found tradition rather than something a caller may read.
 */
const NO_VERDICT_EXIT_CODE = 127;

/**
 * Describe a run that produced no verdict, in one line.
 *
 * Node puts the useful part in `code` (`ENOENT`, `ETIMEDOUT`, …) and repeats
 * the command plus, sometimes, an entire captured transcript in `message`.
 * Only the first line of the message is kept: this string is a reason a leg is
 * inconclusive, not a report of findings, and it goes into the gate output
 * uncapped.
 */
function describeRunFailure(err: { readonly code?: string; readonly message?: string }): string {
  const firstLine = (err.message ?? '').split('\n')[0]?.trim() ?? '';
  const code = typeof err.code === 'string' ? err.code : '';
  if (code && firstLine) return `${code}: ${firstLine}`;
  return code || firstLine || 'the command did not run to completion';
}

/**
 * The runner this gate is composed with in production.
 *
 * It lives beside the contract it implements rather than in the handler,
 * because the handler's own adapter was where the contract quietly stopped
 * being honoured: it dropped `timeoutMs` (so nothing this gate spawned had a
 * bounded wall clock) and never set `spawnError` (so a linter that could not be
 * launched arrived as exit 1 and was read as a lint failure — a false red on a
 * check that never ran).
 *
 * The discriminant is a NUMERIC EXIT STATUS, not an errno table. A process that
 * exited produced a verdict, whatever the code; a throw that carries no numeric
 * `status` means no verdict exists — the binary was not found, the wall-clock
 * bound killed the run, the output ceiling killed it — and every one of those
 * is inconclusive for this gate, which treats them all the same way. Callers
 * that need to tell those apart classify the errno themselves; this one does
 * not, so it does not carry a table it would have to keep correct.
 */
export const execCommandRunner: RunCommandFn = (
  cmd: string,
  args: readonly string[],
  options?: { cwd?: string; timeoutMs?: number },
): CommandResult => {
  try {
    const stdout = runCommandSync(cmd, args, {
      encoding: 'utf-8',
      cwd: options?.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: CHECK_COMMAND_MAX_OUTPUT_BYTES,
      timeout: options?.timeoutMs ?? CHECK_COMMAND_TIMEOUT_MS,
    }) as string;
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const execErr = err as {
      status?: number;
      code?: string;
      message?: string;
      stdout?: string;
      stderr?: string;
    };
    const stdout = typeof execErr.stdout === 'string' ? execErr.stdout : '';
    const stderr = typeof execErr.stderr === 'string' ? execErr.stderr : '';
    if (typeof execErr.status === 'number') {
      return { exitCode: execErr.status, stdout, stderr };
    }
    return {
      exitCode: NO_VERDICT_EXIT_CODE,
      stdout,
      stderr,
      spawnError: describeRunFailure(execErr),
    };
  }
};

/**
 * The part of a loaded `.exarchos.yml` this gate reads.
 *
 * Declared as what is consumed rather than as the loader's whole result, so the
 * seam states its own requirement and a test can satisfy it without building a
 * validated config document. The real loader satisfies it structurally.
 */
export interface ToolchainConfigSource {
  readonly config: { readonly toolchains?: readonly ConfigToolchain[] | undefined };
}

/** Reads the repository's toolchain declarations, or null when it has none. */
export type LoadToolchainConfigFn = (repoRoot: string) => ToolchainConfigSource | null;

export interface StaticAnalysisInput {
  /** Repository root to analyze. */
  readonly repoRoot: string;
  /** Skip lint check. */
  readonly skipLint?: boolean | undefined;
  /** Skip typecheck. */
  readonly skipTypecheck?: boolean | undefined;
  /** External command runner (dependency injection). */
  readonly runCommand: RunCommandFn;
  /**
   * Reads the repository's `.exarchos.yml`, whose `toolchains:` block is the
   * sanctioned way to extend or override what a repository is detected as.
   * Injectable so the extension point is testable without a file on disk;
   * unset means the real loader, which is what production uses.
   */
  readonly loadConfig?: LoadToolchainConfigFn | undefined;
}

/**
 * Reason code for a 'skip' status.
 *
 * - 'no-toolchain'        — nothing this gate can run checks for: no recognized
 *                           project files in repoRoot, or a toolchain it has no
 *                           runner for.
 * - 'constituent-skipped' — a toolchain was detected and at least one
 *                           constituent check did not run — including the case
 *                           where the toolchain assembled no runnable check at
 *                           all. The gate is DEGRADED/inconclusive: it may not
 *                           report PASS.
 */
export type StaticAnalysisSkipReason = 'no-toolchain' | 'constituent-skipped';

export interface StaticAnalysisResult {
  /**
   * Overall status.
   *
   * - 'pass'  — EVERY applicable check ran and passed, and there was at least
   *             one. A single skipped constituent forbids this value, and so
   *             does an empty set of them.
   * - 'fail'  — one or more checks failed
   * - 'skip'  — inconclusive; see `skipReason` for the reason code. Distinct
   *             from 'pass' so the gate does not falsely-green a repo with no
   *             recognized toolchain, or with a check that never ran.
   * - 'error' — usage error (missing/invalid repo root, unreadable config)
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
  /**
   * Number of constituent checks that did NOT run (missing script, --skip-*
   * flag, a command that could not be launched, or a toolchain that declared
   * nothing runnable). Non-zero forces the aggregate away from 'pass'.
   */
  readonly skipCount: number;
  /**
   * The registry's label for the detected toolchain, whether or not this gate
   * could check it. Undefined only when nothing was detected at all — which is
   * what separates "no project here" from "a project this gate cannot check".
   */
  readonly projectType?: string | undefined;
}

// ============================================================
// IMPORT-BOUNDARY LINT (structural layer)
// ============================================================
//
// The boundary-lint leg rides the static-analysis gate to enforce
// architectural import boundaries (e.g. "domain core must not import the IO
// facade"). It is the STRUCTURAL half: a boundary check on the
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
// Implementation decision (#1529): the taint leg is driven by an
// EXTERNAL resolved engine (Semgrep), not a hand-rolled TypeScript-compiler AST
// walk. Rationale: (1) bundling the TS compiler into the shipped runtime to
// re-implement dataflow is disproportionate; (2) one engine (Semgrep) serves
// TS *and* the non-TS degrade the research names (CodeQL is the heavier
// alternative), so the guarantee is language-agnostic with a single per-runtime
// implementation (one guarantee, at parity across runtimes) rather than a
// TS-only primary + a separate
// degrade; (3) the ruleset — not code — encodes BOTH halves of the invariant:
// (a) raw IO (`JSON.parse` / `response.json()` / `req.body` / `fs.read*`) whose
// result is not consumed by a registered parser, AND (b) out-of-band
// `as Brand` / `as any` casts downstream (Zod `.brand()` is compile-time-only;
// one stray cast defeats the scheme). The registered-parser surface is a
// resolved convention (`parsers: ['src/parse/**']`) referenced by the ruleset,
// not baked into this module.
//
// Degrade discipline: a repo with no `.dependency-cruiser.cjs` (or with
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

/** Verdict of the import-boundary leg. SKIP is the advisory degrade. */
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
      { cwd: repoRoot, timeoutMs: CHECK_COMMAND_TIMEOUT_MS },
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
// BOUNDARY-PARSE TAINT (dataflow layer, #1529)
// ============================================================
//
// "No raw IO into the core": untrusted input must cross a registered parser
// before entering the domain core, and no out-of-band cast may forge a branded
// type downstream. This is a DATAFLOW concern dependency-cruiser cannot express
// (it sees imports, not value flow), so it rides its own resolved engine.
//
// The engine is Semgrep (resolved, not bundled — see the decision note above).
// The leg follows the exact degrade discipline as Layer A: it only runs
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

/** Verdict of the boundary-parse taint leg. SKIP is the advisory degrade. */
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
      { cwd: repoRoot, timeoutMs: CHECK_COMMAND_TIMEOUT_MS },
    );
  } catch {
    // Engine absent / not resolvable → degrade to SKIP, never a hard failure.
    return { status: 'SKIP', detail: 'semgrep not available' };
  }

  if (result.spawnError) {
    // The runner reports an unspawnable engine (ENOENT/EACCES) via `spawnError`
    // rather than throwing — when it does, `exitCode` is NOT authoritative, so a
    // coincidental `1` must not read as a boundary finding. Degrade to SKIP,
    // the same discipline as the throw path above (and the contract the
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
  // code is inconclusive, not a violation ⇒ degrade to SKIP, the same
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
 * The reason a command produced no verdict, or null when its exit code is
 * authoritative.
 *
 * `spawnError` is the runner's channel for "the process never ran to
 * completion" — an unresolvable binary, or a run the wall-clock bound cut
 * short. In both cases `exitCode` carries whatever the platform happened to
 * put there, so reading it as a failure invents evidence: nothing was checked.
 * The leg SKIPs, which the aggregate already treats as inconclusive and
 * refuses to render as a pass. The taint leg above has always honoured this
 * field; the lint and typecheck legs did not, so an unlaunchable linter read
 * as a lint failure.
 */
function didNotRun(result: CommandResult): string | null {
  if (!result.spawnError) return null;
  return result.spawnError.trim() || 'the command did not run to completion';
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
// FAIL-DETAIL CAP (counts, not transcripts)
// ============================================================
//
// A failing lint/typecheck run can emit hundreds of lines of transcript. Echoing
// the whole dump into the gate response is the O-3 unbounded-echo the token-
// economy audit named: the reviewer pays for a 500-line wall of text when
// a first page + counts + a re-run hint is enough to triage. This caps the raw
// detail to `FAIL_DETAIL_MAX_LINES`, then appends:
//   (a) the total line count (so the reader knows how much was elided),
//   (b) a per-file failure breakdown naming EVERY distinct failing file with its
//       line count — computed over the FULL raw output, not just the kept head —
//       so triage never has to re-run the uncapped path to answer "what failed",
//   (c) a steering suffix pointing at the escape hatch (re-run for full output).
//
// Fidelity over brevity for the file list: the head is capped, but the complete
// set of failing files is always named. Short details (≤ cap) pass through
// byte-identically so existing single-line FAIL messages keep their exact shape.

/** Maximum raw transcript lines kept in a FAIL detail before the cap engages. */
export const FAIL_DETAIL_MAX_LINES = 50;

/**
 * Maximum distinct failing files enumerated in the per-file breakdown. Without
 * this cap a large cascade appends one line per file, so the "capped" detail can
 * still blow the response budget the line cap exists to protect.
 */
export const FAIL_DETAIL_MAX_FILES = 20;

/**
 * Path-like token ending in a recognized source extension. Used to attribute
 * each transcript line to a failing file. Matches tsc (`src/foo.ts(12,5):`),
 * eslint stylish headers (`/abs/src/foo.ts`), eslint unix/compact
 * (`src/foo.ts:12:5:`), and bare-root files (`foo.ts`). A leading `/`, `./`, or
 * `../` is captured when present; intermediate directories are optional.
 */
const FILE_TOKEN_RE =
  /(?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mts|cts|mjs|cjs|cs|go|rs|py|json|vue|svelte)\b/;

/** Extract the first file-path token on a transcript line, or null if none. */
function extractFileToken(line: string): string | null {
  const m = FILE_TOKEN_RE.exec(line);
  return m ? m[0] : null;
}

/**
 * Count transcript lines attributable to each distinct failing file, over the
 * FULL raw output. Insertion order preserved for files with equal counts, so
 * output is deterministic given the input.
 */
function fileFailureCounts(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const file = extractFileToken(line);
    if (file) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

/**
 * Cap a verbose FAIL `detail` (raw lint/typecheck transcript) to the first
 * `FAIL_DETAIL_MAX_LINES` lines plus a total count, a per-file failing breakdown
 * (itself capped at `FAIL_DETAIL_MAX_FILES` with an elided-count line), and a
 * steering suffix. Returns the detail unchanged when it already fits within the
 * cap (preserving the exact shape of short single-line messages).
 *
 * @param rawDetail    the full (already-trimmed) tool transcript
 * @param rerunCommand the command the reviewer re-runs for the uncapped output
 */
export function capFailDetail(rawDetail: string, rerunCommand: string): string {
  const lines = rawDetail.split('\n');
  const total = lines.length;
  if (total <= FAIL_DETAIL_MAX_LINES) {
    return rawDetail;
  }

  const fileCounts = fileFailureCounts(lines);
  const parts: string[] = lines.slice(0, FAIL_DETAIL_MAX_LINES);

  parts.push('');
  parts.push(
    `… output capped at ${FAIL_DETAIL_MAX_LINES} of ${total} lines (${total - FAIL_DETAIL_MAX_LINES} more elided).`,
  );

  if (fileCounts.size > 0) {
    // Highest line count first; ties broken by first-seen order (Map iteration).
    const ordered = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]);
    parts.push(`Failing files (${fileCounts.size}):`);
    const shown = ordered.slice(0, FAIL_DETAIL_MAX_FILES);
    for (const [file, count] of shown) {
      parts.push(`  ${file}: ${count}`);
    }
    if (ordered.length > shown.length) {
      parts.push(`  …and ${ordered.length - shown.length} more files.`);
    }
  }

  parts.push(`Re-run \`${rerunCommand}\` for the full output.`);
  return parts.join('\n');
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
    const result = runCommand('npm', ['run', scriptName], {
      cwd: repoRoot,
      timeoutMs: CHECK_COMMAND_TIMEOUT_MS,
    });
    const unran = didNotRun(result);
    if (unran) return { name, status: 'SKIP', detail: unran };
    if (result.exitCode === 0) {
      return { name, status: 'PASS' };
    }
    const detail = capFailDetail(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `npm run ${scriptName} failed`,
      `npm run ${scriptName}`,
    );
    return { name, status: 'FAIL', detail };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: 'FAIL', detail: message };
  }
}

// ============================================================
// WHICH TOOLCHAINS THIS GATE CAN CHECK
// ============================================================

/**
 * Toolchain ids this gate has runnable checks for.
 *
 * Detection is delegated wholesale to the shared registry, which is the single
 * source of truth for markers and recognises considerably more toolchains than
 * this set. Membership here answers the narrower question of whether a
 * DETECTED toolchain has anything to run, and a non-member is an honest skip,
 * never a pass.
 *
 * Exported because the difference between this set and the registry is the
 * gate's real coverage, and an unmeasured difference is one that grows: a
 * toolchain added to the registry with no runner here changed nothing that
 * could be seen. `tests/architecture/gate-toolchain-coverage.test.ts` pins the
 * uncovered ids by name so the list can only shrink.
 *
 * This set governs BUILT-IN toolchains. A repository that declares its own is
 * admitted on different terms — see {@link isCheckable}.
 */
export const SUPPORTED_TOOLCHAINS: ReadonlySet<string> = new Set([
  'node',
  'dotnet',
  'rust',
  'go',
]);

/** Every marker the registry recognises, for an honest "nothing detected" report. */
function allRegistryMarkers(): string[] {
  return BUILTIN_TOOLCHAINS.flatMap((t) => t.markers);
}

// ============================================================
// TOOLCHAIN RESOLUTION
// ============================================================

/** A detected toolchain plus where the declaration came from. */
interface ToolchainResolution {
  readonly toolchain: Toolchain | undefined;
  /** True when the match came from the repository's own `toolchains:` block. */
  readonly userDeclared: boolean;
}

/**
 * Detect the repository's toolchain, letting its own `.exarchos.yml`
 * `toolchains:` block participate.
 *
 * That block is the sanctioned way to extend or override detection, and every
 * other consumer of the registry already passes it. This gate did not, so a
 * repository could declare its commands, watch the test runtime honour them,
 * and still be told static analysis had no runner for it.
 *
 * Throws whatever the loader throws. A `.exarchos.yml` that cannot be parsed or
 * validated is not an absent one: continuing would mean running the gate
 * against a detection the operator did not ask for and reporting the result as
 * if nothing were wrong.
 */
function resolveToolchain(
  repoRoot: string,
  loadConfig: LoadToolchainConfigFn,
): ToolchainResolution {
  const declared = (loadConfig(repoRoot)?.config.toolchains ?? []).map(toolchainFromConfig);
  if (declared.length === 0) {
    return { toolchain: detectToolchain(repoRoot), userDeclared: false };
  }
  const matched = detectToolchain(repoRoot, declared);
  return { toolchain: matched, userDeclared: matched !== undefined && declared.includes(matched) };
}

/**
 * Whether this gate has checks to run for a detected toolchain.
 *
 * Two different questions, deliberately answered differently. For a BUILT-IN
 * toolchain the gate has to decide on the repository's behalf what a partial
 * registry declaration should mean, and {@link SUPPORTED_TOOLCHAINS} is where
 * that decision is recorded. A repository that declares its own toolchain has
 * already made the decision itself by naming the commands, so refusing it would
 * make the extension point advisory. Either way a toolchain that names nothing
 * runnable is inconclusive, not a pass — see {@link runToolchainChecks}.
 */
function isCheckable(toolchain: Toolchain, userDeclared: boolean): boolean {
  if (SUPPORTED_TOOLCHAINS.has(toolchain.id)) return true;
  return userDeclared && declaresRunnableCheck(toolchain);
}

// ============================================================
// CHECK LEGS: REGISTRY FIRST, SUPPLEMENTS BY EXCEPTION
// ============================================================
//
// The commands are the registry's to declare. This gate used to re-derive one
// literal per language beside a detection call that already knew the answer,
// which is how the same knowledge came to disagree with itself elsewhere. So:
// a detected toolchain's `commands.lint` and `commands.typecheck` ARE the lint
// and typecheck legs, and only what the registry declines to declare is
// supplied here — by exception, named, with the reason it cannot come from the
// registry.
//
// Measured against the registry as it stands, the four toolchains this gate
// runs split three ways:
//   - go     — the registry's lint command is byte-identical to the literal
//              this module used to carry. Pure duplication; now sourced.
//   - rust   — the registry declares the linter and no typecheck command. The
//              linter is taken as declared; `cargo check` remains a supplement.
//   - dotnet — the registry declares neither leg for it.
//   - node   — the registry's node commands do not answer this gate's question
//              at all (see runNodeChecks).

/** Which `--skip-*` flag suppresses a supplement leg. */
type SkipAxis = 'lint' | 'typecheck' | 'both';

interface SupplementLeg {
  /** Report label. */
  readonly name: string;
  /** The command, exactly as it would be typed. */
  readonly command: string;
  /** `'both'` means the leg runs unless BOTH skip flags are set. */
  readonly axis: SkipAxis;
}

/**
 * Legs the registry does not declare, keyed by toolchain id, each with the
 * reason it is here. An entry whose command the registry later declares has
 * become a duplicate and should be deleted rather than kept in step.
 */
const COMMAND_SUPPLEMENTS: Readonly<Record<string, readonly SupplementLeg[]>> = {
  // The registry declares no lint and no typecheck command for .NET. The
  // compiler is both, and promoting warnings is what makes a build a check.
  dotnet: [
    { name: 'Build', command: 'dotnet build --no-restore -warnaserror', axis: 'both' },
  ],
  // The registry declares rust's linter but no typecheck command; a
  // compile-only pass is the leg clippy does not stand in for.
  rust: [{ name: 'Check', command: 'cargo check', axis: 'typecheck' }],
};

/**
 * Tokens appended to a toolchain's declared linter so that what it finds
 * actually fails the leg.
 *
 * A linter whose findings exit zero contributes a PASS while establishing
 * nothing: the leg ran, and no outcome of it could have been a failure. Clippy
 * is exactly that — its default level for most lints is `warn`, so a crate can
 * be thick with findings and still exit 0. The registry declares the linter's
 * IDENTITY, which is the right thing for it to own; whether a finding is
 * allowed to block is this gate's question, and it is answered the same way the
 * .NET leg answers it with `-warnaserror`.
 *
 * `go vet` needs no entry: it already exits non-zero on what it reports. An
 * entry here is a claim that a toolchain's declared linter cannot fail without
 * one, so adding a row is a decision, not a default.
 */
const LINT_FAILING_MODE: Readonly<Record<string, readonly string[]>> = {
  rust: ['--', '-D', 'warnings'],
};

/**
 * The promotion tokens for a declared lint command, or none.
 *
 * Withheld when the declared command already passes flags through to the
 * compiler (a `--` separator): a repository that writes its own
 * `cargo clippy -- …` has chosen its lint levels, and a second separator would
 * corrupt the argv rather than harden it.
 */
function lintFailingMode(toolchainId: string, command: string): readonly string[] {
  const promote = LINT_FAILING_MODE[toolchainId];
  if (!promote) return [];
  return command.trim().split(/\s+/).includes('--') ? [] : promote;
}

/** Split a declared command string into an executable plus argv. */
function splitCommand(
  command: string,
): { readonly cmd: string; readonly args: readonly string[] } | null {
  const [cmd, ...args] = command.trim().split(/\s+/).filter((p) => p.length > 0);
  return cmd ? { cmd, args } : null;
}

/** Run one declared command, plus any appended tokens, as a named check leg. */
function runDeclaredCheck(
  name: string,
  command: string,
  extraArgs: readonly string[],
  repoRoot: string,
  runCommand: RunCommandFn,
  skip: boolean,
): CheckResult {
  const parsed = splitCommand(command);
  if (!parsed) {
    return { name, status: 'SKIP', detail: 'no runnable command declared' };
  }
  return runGenericCheck(
    name,
    parsed.cmd,
    [...parsed.args, ...extraArgs],
    repoRoot,
    runCommand,
    skip,
  );
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
    const result = runCommand(cmd, args, {
      cwd: repoRoot,
      timeoutMs: CHECK_COMMAND_TIMEOUT_MS,
    });
    const unran = didNotRun(result);
    if (unran) return { name, status: 'SKIP', detail: unran };
    if (result.exitCode === 0) {
      return { name, status: 'PASS' };
    }
    const rerun = `${cmd} ${args.join(' ')}`;
    const detail = capFailDetail(
      result.stderr.trim() || result.stdout.trim() || `${rerun} failed`,
      rerun,
    );
    return { name, status: 'FAIL', detail };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: 'FAIL', detail: message };
  }
}

// ============================================================
// PER-TOOLCHAIN CHECK ASSEMBLY
// ============================================================

/**
 * The node legs, which are the one case the registry cannot answer.
 *
 * A node repository's lint and typecheck are package.json SCRIPTS, not
 * commands: the registry declares no node linter precisely because there is no
 * conventional invocation to declare, and its `tsc --noEmit` would run the
 * compiler over whatever the working directory happens to be instead of the
 * project the repository's own script targets. Going through the script also
 * keeps the check on whatever package manager the repository uses. An absent
 * script is a SKIP, which degrades the aggregate — a check that never ran is
 * not evidence that it would have passed.
 */
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

/** Report label for the leg that stands in when a toolchain assembles none. */
const NO_CHECKS_NAME = 'Applicable checks';

/** Whether a toolchain declares a command this gate could run as a check. */
function declaresRunnableCheck(toolchain: Toolchain): boolean {
  return toolchain.commands.lint !== null || toolchain.commands.typecheck !== null;
}

/**
 * Assemble and run the check legs for a detected toolchain: whatever the
 * registry declares, plus this module's named supplements for what it does not.
 *
 * Returns at least one leg, always. A toolchain that assembles nothing runnable
 * gets an explicit SKIP leg instead of an empty list, because an empty list is
 * how a gate comes to report `PASS (0/0 checks passed)` — green off nothing at
 * all, which is the one verdict this module exists to make unreachable. The
 * substitution happens here rather than in the tally so the aggregate keeps a
 * single rule (any skipped constituent degrades) instead of growing a special
 * case for a count it should never see.
 */
function runToolchainChecks(
  toolchain: Toolchain,
  userDeclared: boolean,
  repoRoot: string,
  runCommand: RunCommandFn,
  skipLint: boolean,
  skipTypecheck: boolean,
): CheckResult[] {
  const checks = assembleToolchainChecks(
    toolchain,
    userDeclared,
    repoRoot,
    runCommand,
    skipLint,
    skipTypecheck,
  );
  if (checks.length > 0) return checks;

  return [
    {
      name: NO_CHECKS_NAME,
      status: 'SKIP',
      detail:
        `nothing runnable is declared for ${toolchain.projectType} ` +
        `(\`${toolchain.id}\`): no lint and no typecheck command`,
    },
  ];
}

function assembleToolchainChecks(
  toolchain: Toolchain,
  userDeclared: boolean,
  repoRoot: string,
  runCommand: RunCommandFn,
  skipLint: boolean,
  skipTypecheck: boolean,
): CheckResult[] {
  // The script indirection is what a node repository gets when nobody has said
  // otherwise. A repository that declares its own node lint/typecheck commands
  // in `.exarchos.yml` has answered the question the indirection exists to
  // answer, so its declaration is honoured instead; one that overrides node
  // detection without naming either command still gets the scripts.
  if (toolchain.id === 'node' && !(userDeclared && declaresRunnableCheck(toolchain))) {
    return runNodeChecks(repoRoot, runCommand, skipLint, skipTypecheck);
  }

  const checks: CheckResult[] = [];
  const { lint, typecheck } = toolchain.commands;
  if (lint) {
    const promote = lintFailingMode(toolchain.id, lint);
    checks.push(runDeclaredCheck('Lint', lint, promote, repoRoot, runCommand, skipLint));
  }
  if (typecheck) {
    checks.push(runDeclaredCheck('Typecheck', typecheck, [], repoRoot, runCommand, skipTypecheck));
  }

  for (const leg of COMMAND_SUPPLEMENTS[toolchain.id] ?? []) {
    const skip =
      leg.axis === 'lint'
        ? skipLint
        : leg.axis === 'typecheck'
          ? skipTypecheck
          : skipLint && skipTypecheck;
    checks.push(runDeclaredCheck(leg.name, leg.command, [], repoRoot, runCommand, skip));
  }

  return checks;
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
      skipCount: 0,
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
        skipCount: 0,
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
      skipCount: 0,
    };
  }

  let resolution: ToolchainResolution;
  try {
    resolution = resolveToolchain(repoRoot, input.loadConfig ?? loadExarchosConfig);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      output: '',
      error: `Cannot resolve the toolchain for ${repoRoot}: ${message}`,
      passCount: 0,
      failCount: 0,
      skipCount: 0,
    };
  }
  const { toolchain, userDeclared } = resolution;

  if (!toolchain || !isCheckable(toolchain, userDeclared)) {
    // Nothing to run returns 'skip' (inconclusive), never 'pass' — a pass
    // would falsely-green any repository this gate simply cannot check.
    // Callers translate a skip into an inconclusive verdict, not a passing one.
    //
    // The two ways to get here are different facts and the report says which.
    // Telling a Python repository that nothing recognised it is false: the
    // registry recognised it fine, and it is this gate that has no runner.
    const detected = toolchain
      ? `Detected ${toolchain.projectType} (\`${toolchain.id}\`), which this gate has no static-analysis runner for`
      : `No recognized project type (none of: ${allRegistryMarkers().join(', ')})`;
    const verdictLine = toolchain
      ? '**Result: SKIP** (no static-analysis runner for the detected toolchain)'
      : '**Result: SKIP** (no applicable toolchain detected)';

    const output = [
      '## Static Analysis Report',
      '',
      `**Repository:** \`${repoRoot}\``,
      '',
      `- **SKIP**: ${detected}`,
      '',
      '---',
      '',
      verdictLine,
    ].join('\n');

    return {
      status: 'skip',
      output,
      skipReason: 'no-toolchain',
      passCount: 0,
      failCount: 0,
      skipCount: 0,
      projectType: toolchain?.projectType,
    };
  }

  const projectType = toolchain.projectType;
  const checks = runToolchainChecks(
    toolchain,
    userDeclared,
    repoRoot,
    runCommand,
    skipLint,
    skipTypecheck,
  );

  // Fold the import-boundary leg into the report
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

  // Fold the boundary-parse taint leg in on the same
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

  // Tally results.
  //
  // SKIP is tallied as a FIRST-CLASS outcome, not discarded. The gate
  // previously counted only PASS/FAIL, so a constituent that never ran was
  // invisible to the verdict — a repo with no `lint` and no `quality-check`
  // script rendered `PASS (2/2)` off a single real check. A check that never
  // ran is not evidence that it would have passed.
  let passCount = 0;
  let failCount = 0;
  let skipCount = 0;

  for (const check of checks) {
    if (check.status === 'PASS') passCount++;
    if (check.status === 'FAIL') failCount++;
    if (check.status === 'SKIP') skipCount++;
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

  // Precedence: FAIL ≻ DEGRADED ≻ PASS.
  //
  // A real failure still dominates (an operator must see the failure first);
  // otherwise ANY skipped constituent degrades the dimension. PASS is
  // reachable only when every constituent actually ran and passed.
  if (failCount > 0) {
    outputLines.push(`**Result: FAIL** (${failCount}/${total} checks failed)`);
  } else if (skipCount > 0) {
    outputLines.push(
      `**Result: DEGRADED** (${passCount}/${total} checks passed, ` +
        `${skipCount} skipped — inconclusive, not a pass)`,
    );
  } else {
    outputLines.push(`**Result: PASS** (${passCount}/${total} checks passed)`);
  }

  const output = outputLines.join('\n');

  const status: StaticAnalysisResult['status'] =
    failCount > 0 ? 'fail' : skipCount > 0 ? 'skip' : 'pass';

  return {
    status,
    output,
    ...(status === 'skip' ? { skipReason: 'constituent-skipped' as const } : {}),
    passCount,
    failCount,
    skipCount,
    projectType,
  };
}
