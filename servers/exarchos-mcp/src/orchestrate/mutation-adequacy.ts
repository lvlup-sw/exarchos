// ─── mutation-adequacy — Stryker report schema + carrier aggregation ────────
//
// The adequacy backstop for the relaxed verification mix (verification-ladder
// slice 3, R5 / #1520). This module owns the REPORT region: an internal Zod
// schema mirroring Stryker's `mutation-testing-report-schema` — the de-facto
// cross-language mutation-report standard (Stryker JS/.NET, and the shape
// cargo-mutants / mutmut adapters normalize toward) — and a pure aggregator
// folding it into the fixed carrier the action returns (design §4.1, §4.6).
//
// Validation is internal Zod now; design §4.1 notes it becomes an MCP Resource
// when #1275 lands — never a tool, never a 5th visible surface (INV-5d). The
// action handler (task 003) consumes `parseMutationReport`; the dimension's
// `passed`/severity (task 006) reads `carrier.mutationScore`.
//
// Robustness contract (design §4.1 #4): a malformed or empty report degrades to
// a typed DEGRADE signal — `parseMutationReport` never throws. The handler maps
// that to a Warning carrier rather than failing the gate closed-with-an-error.
// ────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { runCommandSync } from '../utils/process.js';
import { z } from 'zod';

import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import {
  resolveVerificationRuntime,
  type ResolvedVerificationRuntime,
} from '../config/test-runtime-resolver.js';
import {
  detectToolchain,
  resolveMutationDiffScope,
  type MutationDiffScope,
} from '../config/toolchains.js';
import { defaultGitExec, emitGateEvent, resolveRepoRoot } from './gate-utils.js';
import { orchestrateLogger } from '../logger.js';

// ─── Stryker mutation-testing-report-schema (subset we consume) ─────────────
//
// We model only the fields the aggregator and survivor-affordance mapping need;
// the report carries more (coverage maps, test files, framework metadata) that
// we deliberately ignore. `.passthrough()` keeps the unknown fields intact
// without constraining them, so a newer Stryker schemaVersion that adds fields
// still validates (forward-compatible) — we pin SHAPE, not EXHAUSTIVENESS.

/**
 * Mutant verdicts, per the Stryker schema's `MutantStatus`. `Killed` and
 * `Timeout` are "detected" (a test caught the mutation); `Survived` is the
 * adequacy gap; `NoCoverage` means no test exercised the mutated code at all.
 * The remaining statuses are unresolved verdicts (the mutant could not be run
 * to a clean kill/survive) — they count toward `total` but neither kills nor
 * survivors, so they depress the score without being affordance-actionable as a
 * "write a test that kills" target.
 */
export const MUTANT_STATUSES = [
  'Killed',
  'Survived',
  'NoCoverage',
  'Timeout',
  'CompileError',
  'RuntimeError',
  'Ignored',
  'Pending',
] as const;

export type MutantStatus = (typeof MUTANT_STATUSES)[number];

/** Statuses that count as a detected (killed) mutant for scoring. */
const KILLED_STATUSES: ReadonlySet<MutantStatus> = new Set<MutantStatus>(['Killed', 'Timeout']);

const PositionSchema = z.object({
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
});

const MutantLocationSchema = z.object({
  start: PositionSchema,
  end: PositionSchema,
});

export const MutantSchema = z
  .object({
    id: z.string(),
    mutatorName: z.string(),
    status: z.enum(MUTANT_STATUSES),
    location: MutantLocationSchema,
  })
  .passthrough();

export type Mutant = z.infer<typeof MutantSchema>;

export const FileResultSchema = z
  .object({
    language: z.string(),
    // `source` is optional in practice — some emitters omit it for diff-scoped
    // runs. The aggregator never reads it, so we keep it permissive.
    source: z.string().optional(),
    mutants: z.array(MutantSchema),
  })
  .passthrough();

export const MutationReportSchema = z
  .object({
    // schemaVersion is a string in the spec ('1', '1.0', …); accept any
    // non-empty string rather than pinning a value we'd have to chase.
    schemaVersion: z.string(),
    thresholds: z
      .object({ high: z.number(), low: z.number() })
      .passthrough()
      .optional(),
    files: z.record(z.string(), FileResultSchema),
  })
  .passthrough();

export type MutationReport = z.infer<typeof MutationReportSchema>;

// ─── Carrier ────────────────────────────────────────────────────────────────

/**
 * The fixed adequacy carrier (design §4.6). `mutationScore` follows the Stryker
 * convention: detected / (total − noCoverage). `total` counts every mutant with
 * a verdict; `noCoverage` is excluded from the denominator (uncovered code does
 * not lower the score for the tests that exist). The handler (task 003) wraps
 * this with `{ passed, report }` to form the full output-contract carrier.
 */
export interface MutationCarrier {
  readonly mutationScore: number;
  readonly killed: number;
  readonly survived: number;
  readonly noCoverage: number;
  readonly total: number;
}

/** Flatten every file's mutant list into one stream. */
function allMutants(report: MutationReport): readonly Mutant[] {
  return Object.values(report.files).flatMap((f) => f.mutants);
}

/**
 * Fold a validated report into the fixed carrier.
 *
 * `mutationScore = killed / (total − noCoverage)`, guarded so a zero
 * denominator (every mutant uncovered, or an empty report) yields 0 rather than
 * NaN — a NaN would silently poison the advisory-threshold comparison
 * downstream (task 006).
 */
export function aggregate(report: MutationReport): MutationCarrier {
  const mutants = allMutants(report);
  let killed = 0;
  let survived = 0;
  let noCoverage = 0;
  for (const m of mutants) {
    if (KILLED_STATUSES.has(m.status)) killed += 1;
    else if (m.status === 'Survived') survived += 1;
    else if (m.status === 'NoCoverage') noCoverage += 1;
  }
  const total = mutants.length;
  const denominator = total - noCoverage;
  const mutationScore = denominator > 0 ? killed / denominator : 0;
  return { mutationScore, killed, survived, noCoverage, total };
}

// ─── Fail-closed parse entry point ──────────────────────────────────────────

/**
 * Tagged result of {@link parseMutationReport}. A discriminated union so the
 * handler branches on `ok` without try/catch; the `reason` on the failure arm
 * is a human-readable degrade message surfaced as a Warning (never a throw).
 */
export type ParseResult =
  | { readonly ok: true; readonly report: MutationReport; readonly carrier: MutationCarrier }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse a Stryker report (a JSON string from stdout/a report file, or an
 * already-parsed object) into the carrier, degrading to a typed signal on any
 * malformation. NEVER throws — empty input, non-JSON, or a shape that fails the
 * schema all return `{ ok: false, reason }`. This is the doctor-grade
 * robustness the action's #4 step depends on.
 */
export function parseMutationReport(input: unknown): ParseResult {
  let candidate: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: 'mutation report was empty' };
    }
    try {
      candidate = JSON.parse(trimmed);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `mutation report was not valid JSON: ${detail}` };
    }
  }

  const parsed = MutationReportSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || '(root)';
    const reason = `mutation report did not match the Stryker report schema at ${where}: ${
      issue?.message ?? 'unknown validation error'
    }`;
    return { ok: false, reason };
  }

  return { ok: true, report: parsed.data, carrier: aggregate(parsed.data) };
}

// ─── Handler — the mutation-adequacy action (task 003–006) ──────────────────
//
// The action handler wires the production seams around the pure report region
// above: resolve the mutation command (slice 2 `resolveVerificationRuntime`),
// compose the per-runner diff scope (002 `resolveMutationDiffScope`), run it
// through an injected runner (no real Stryker in tests — DIM-4), parse + fold
// the report, map survivors to affordances (005 / INV-12), emit the liveness
// pair + foldable `gate.executed` (004 / INV-10 / INV-1), and apply the
// advisory severity (006) reusing the slice-2 mechanism. The result is always
// an INV-5b advisory carrier (`success:true` + `data.passed`) — a Skipped /
// Warning / deferred path degrades, it never throws an error envelope.
// ────────────────────────────────────────────────────────────────────────────

/** Soft default adequacy threshold (design §4.6 — ~40% per the observed distribution). */
export const DEFAULT_MUTATION_THRESHOLD = 0.4;

/** The gate name + review layer this action stamps (INV-2: declared once here). */
export const MUTATION_GATE_NAME = 'mutation-adequacy';
const MUTATION_GATE_LAYER = 'review';

/**
 * Result of the injected mutation runner. `ok:true` carries the Stryker report
 * (a JSON string from stdout/a report file, or an already-parsed object) so the
 * handler can `parseMutationReport` it; `ok:false` is a run-level degrade
 * (non-zero exit with no parseable report) the handler surfaces as a Warning.
 */
export type MutationRunResult =
  | { readonly ok: true; readonly report: unknown }
  | { readonly ok: false; readonly reason: string };

/** Arguments the injected runner receives — the already diff-scoped command. */
export interface MutationRunArgs {
  readonly command: string;
  readonly repoRoot: string;
  readonly base: string;
}

/**
 * Handler args. `base` reuses the existing `string` field contract verbatim
 * (the registration-schema field-collision trap). `scope` is a plain string at
 * the registration boundary (matching `prepare_review.scope` to dodge that same
 * trap) and validated to `'diff' | 'full'` here, defaulting to `'diff'`.
 */
export interface MutationAdequacyArgs {
  readonly featureId: string;
  /** The review/PR base ref the mutation run is diff-scoped against. */
  readonly base: string;
  /** Repo to run in. `'auto'` resolves the calling delegation's worktree (#1330). */
  readonly repoRoot?: string;
  /** Explicit worktree for `repoRoot:'auto'`; preferred over the event lookup. */
  readonly worktreePath?: string;
  /**
   * Task whose `worktree.created` event resolves `repoRoot:'auto'` when no
   * explicit `worktreePath` is supplied (#1330), mirroring check_test_adequacy.
   * Without it, an `'auto'` repoRoot can only resolve from `worktreePath` — so
   * omitting both leaves `'auto'` unresolvable (a returned INVALID_INPUT).
   */
  readonly taskId?: string;
  /** Idempotency key for the gate emission (INV-8). */
  readonly operationId?: string;
  /** Adequacy threshold override; falls back to config, then the soft default. */
  readonly threshold?: number;
  /**
   * `'diff'` (default) runs scoped. `'full'` runs the whole tree — but ONLY behind
   * the explicit `offline` opt-in (DR-6); without it, `'full'` returns a deferred
   * advisory (the long-running op belongs to a nightly/offline lane, never inline
   * `/review`).
   */
  readonly scope?: string;
  /**
   * DR-6: explicit offline/opt-in for a full-tree mutation run. Only an offline
   * caller (nightly job, manual `--offline`) sets this; inline `/review` never
   * does, so `scope:'full'` stays deferred on the inline path (no wall-clock
   * full-tree run). Ignored for `scope:'diff'`.
   */
  readonly offline?: boolean;
  /** Resolved project config — threaded by the dispatch adapter (severity + threshold). */
  readonly projectConfig?: ResolvedProjectConfig;

  // ── seams (DI; production defaults below) ────────────────────────────────
  /** Verification-runtime resolver. Defaults to {@link resolveVerificationRuntime}. */
  readonly resolve?: (repoRoot: string) => ResolvedVerificationRuntime;
  /** Toolchain-id resolver for the diff-scope table. Defaults to {@link detectToolchain}. */
  readonly detectToolchainId?: (repoRoot: string) => string | null;
  /** Mutation runner. Defaults to a real shell-out capturing stdout as the report. */
  readonly runMutation?: (args: MutationRunArgs) => MutationRunResult | Promise<MutationRunResult>;
  /**
   * Diff seam used to resolve the per-runner diff-scope (PIT `<changed>` classes,
   * mutmut changed paths). Defaults to {@link defaultRunDiff}; injected in tests
   * so no real git/diff runs (DR-5 / Gap C).
   */
  readonly runDiff?: RunDiff;
}

// ─── Diff seam (DR-5, Gap C) ─────────────────────────────────────────────────
//
// `composeScopedCommand` needs the diff to materialize two per-runner scopes the
// descriptor leaves as a `<changed>` placeholder: PIT's `-DtargetClasses` (the
// changed Java classes) and mutmut's `--paths-to-mutate` (the changed .py
// paths). The diff is injected as a `runDiff` seam so the unit tests mock it —
// no real git/diff ever runs in the suite. The production default shells out to
// `git diff --name-only <base>...HEAD` (the merge-base form the sibling
// test-adequacy probe uses), degrading to `[]` on any git failure so a scope
// computation never throws into the run path.

/** Resolves the repo-relative paths changed since `base` (injectable diff seam). */
export type RunDiff = (base: string, repoRoot: string) => readonly string[];

/** Default diff seam: `git diff --name-only <base>...HEAD`; `[]` on any git failure. */
export const defaultRunDiff: RunDiff = (base, repoRoot) => {
  const result = defaultGitExec(repoRoot, ['diff', '--name-only', `${base}...HEAD`]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

/** Context the diff-scope applier needs to resolve a `<changed>` placeholder. */
export interface ScopeContext {
  readonly base: string;
  readonly repoRoot: string;
  readonly runDiff: RunDiff;
}

/**
 * Map changed `.java` file paths to PIT `-DtargetClasses` fully-qualified class
 * names. The Maven/Gradle convention places sources under `src/{main,test}/java/`
 * (or a bare `java/` root); the FQCN is the path below that root with `/`→`.` and
 * the `.java` extension dropped (`src/main/java/com/x/Foo.java` → `com.x.Foo`). A
 * `.java` path with no recognizable source root falls back to its dotted form.
 * Non-`.java` files are ignored. De-duplicated, order-preserving.
 */
function changedJavaClasses(files: readonly string[]): string[] {
  const classes = new Set<string>();
  for (const file of files) {
    const posix = file.replace(/\\/g, '/');
    if (!posix.endsWith('.java')) continue;
    const noExt = posix.slice(0, -'.java'.length);
    const rooted = noExt.match(/(?:^|\/)(?:src\/(?:main|test)\/java|java)\/(.+)$/);
    const rel = rooted ? rooted[1] : noExt;
    classes.add(rel.replace(/\//g, '.'));
  }
  return [...classes];
}

/**
 * Changed `.py` file paths for mutmut's `--paths-to-mutate` restriction
 * (POSIX-normalized, de-duplicated, order-preserving). Non-`.py` files are
 * ignored.
 *
 * (A higher-fidelity LINE-level scope is possible via mutmut's `--use-patch-file`
 * — only mutate lines in a materialized patch — but that needs a patch artifact
 * on disk; path restriction is the seam this slice ships.)
 */
function changedPythonPaths(files: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    const posix = file.replace(/\\/g, '/');
    if (posix.endsWith('.py')) paths.add(posix);
  }
  return [...paths];
}

/**
 * Compose a resolved mutation command with its per-runner diff scope. The
 * augmentation identity lives in the toolchains SoT (002); the handler stays
 * runner-agnostic. The diff-derived placeholders are resolved against the
 * injected `runDiff` seam (DR-5 / Gap C):
 *
 *   - `append-flag` carrying `<changed>` (PIT `-DtargetClasses=<changed>`) →
 *     substitute the changed Java classes derived from the diff;
 *   - `path-restricted` (mutmut `--paths-to-mutate=<changed>`) → substitute the
 *     changed `.py` paths.
 *
 * When the diff touches no scopable file for the runner there is nothing to
 * scope to — rather than ship an empty placeholder or silently mutate the whole
 * tree, it degrades to the unscoped-warning contract (never silently full-tree).
 * Returns the scoped command and any warning to surface.
 */
export function composeScopedCommand(
  command: string,
  scope: MutationDiffScope,
  ctx: ScopeContext,
): { readonly command: string; readonly warning?: string } {
  switch (scope.kind) {
    case 'append-flag': {
      if (scope.flag.includes('<changed>')) {
        // PIT: resolve `<changed>` to the changed classes derived from the diff
        // and substitute them into the flag (`-DtargetClasses=com.x.Foo,...`).
        // A literal `<changed>` must NEVER reach the runner (it would scope to a
        // class named `<changed>`); an empty changed-set degrades to a warning.
        const classes = changedJavaClasses(ctx.runDiff(ctx.base, ctx.repoRoot));
        if (classes.length === 0) {
          return {
            command,
            warning:
              `mutation diff-scope resolved no changed classes for flag ` +
              `'${scope.flag}' (the diff touched no Java sources); the mutation ` +
              `run is unscoped (full-tree) for now`,
          };
        }
        const flag = scope.flag.replace('<changed>', classes.join(','));
        return { command: `${command} ${flag}` };
      }
      // `tokenized` only affects shell-quoting, which the runner owns; here we
      // append the flag string verbatim (it already carries its own spacing).
      return { command: `${command} ${scope.flag}` };
    }
    case 'already-native':
      // The runner already diff-scopes itself (cargo-mutants `--in-diff`);
      // appending a second scope would double-scope. Append nothing — and never
      // consult the diff seam (there is no placeholder to resolve).
      return { command };
    case 'path-restricted': {
      // mutmut: restrict the run to the diff's changed `.py` paths via the
      // descriptor's flag template (`--paths-to-mutate=<changed>`). An empty
      // changed-set degrades to a warning rather than silently mutating the
      // whole tree while the descriptor claims a scope.
      const paths = changedPythonPaths(ctx.runDiff(ctx.base, ctx.repoRoot));
      if (paths.length === 0) {
        return {
          command,
          warning:
            `path-restricted mutation diff-scope resolved no changed paths ` +
            `(the diff touched no Python sources); the mutation run is unscoped ` +
            `(full-tree) for now`,
        };
      }
      const flag = scope.flag.replace('<changed>', paths.join(','));
      return { command: `${command} ${flag}` };
    }
    case 'unscoped-warning':
      return { command, warning: scope.warning };
  }
}

/** Default production runner: shell out, capturing stdout as the Stryker report. */
function defaultRunMutation(args: MutationRunArgs): MutationRunResult {
  const tokens = args.command.split(/\s+/).filter((t) => t.length > 0);
  const [bin, ...rest] = tokens;
  if (!bin) return { ok: false, reason: 'no resolvable mutation command' };
  try {
    // runCommandSync (not raw execFileSync): the mutation command resolves to a
    // package-manager shim (`npx stryker`, `npm run mutation`) whose `.cmd`
    // launcher execFile refuses to start on Windows since CVE-2024-27980
    // (Node >= 20.12.2). (#1623)
    const stdout = runCommandSync(bin, rest, {
      cwd: args.repoRoot,
      timeout: 600_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    return { ok: true, report: stdout };
  } catch (err) {
    const e = err as { stdout?: string | Buffer; status?: number };
    const out = typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf-8') ?? '';
    // A non-zero exit with a parseable report on stdout is still a usable run
    // (mutation runners exit non-zero below their own threshold). Hand the
    // stdout to the parser; an empty/unparseable stdout degrades to a Warning.
    if (out.trim().length > 0) return { ok: true, report: out };
    return { ok: false, reason: `mutation run produced no report (exit ${e.status ?? 'unknown'})` };
  }
}

/** Map surviving + NoCoverage mutants to "write a test that kills file:line" steers (INV-12). */
function survivorAffordances(report: MutationReport): string[] {
  const actions: string[] = [];
  for (const [file, result] of Object.entries(report.files)) {
    for (const m of result.mutants) {
      if (m.status === 'Survived' || m.status === 'NoCoverage') {
        actions.push(`write a test that kills ${file}:${m.location.start.line}`);
      }
    }
  }
  return actions;
}

/**
 * The mutation-adequacy action handler.
 *
 * Always returns an INV-5b advisory carrier. The dispatch branch in
 * `composite.ts` routes here; the test suite dispatches THROUGH
 * `handleOrchestrate` (the DOA-action trap).
 */
export async function handleMutationAdequacy(
  args: MutationAdequacyArgs,
  _stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!eventStore) {
    return {
      success: false,
      error: { code: 'MISWIRED_CONTEXT', message: 'handleMutationAdequacy: eventStore is required' },
    };
  }
  if (!args.featureId) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'featureId is required' } };
  }
  if (!args.base) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'base is required' } };
  }

  // Validate `scope` at the handler boundary (the registration declares it as a
  // plain string to dodge the field-collision trap). Default to 'diff' ONLY when
  // omitted; a provided-but-unrecognised value (e.g. the typo 'dif') is an
  // INVALID_INPUT rather than a silent coercion to 'diff' that would change
  // behaviour without telling the caller (INV-5a / INV-5b).
  let scope: 'diff' | 'full';
  if (args.scope === undefined) {
    scope = 'diff';
  } else if (args.scope === 'diff' || args.scope === 'full') {
    scope = args.scope;
  } else {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `scope must be 'diff' or 'full' when provided (got '${args.scope}')`,
      },
    };
  }

  // ── §4.5 / DR-6 — `full` scope is the canonical long-running op. Inline
  // `/review` (no `offline` opt-in) NEVER runs it full-tree — it would defeat
  // the token/wall-clock goal (research §6 Q3): return a deferred advisory, no
  // runner call. Only an explicit offline caller (`offline:true` — a nightly job
  // or `--offline`) falls through to the real full-tree run below.
  if (scope === 'full' && !args.offline) {
    return {
      success: true,
      data: {
        passed: true,
        deferred: true,
        scope: 'full',
        mutationScore: 0,
        killed: 0,
        survived: 0,
        noCoverage: 0,
        total: 0,
        reason:
          'full-tree mutation is the long-running op deferred to R10/v2.12 ' +
          '(nightly/offline via the Task lifecycle verbs); only diff-scoped runs ' +
          'execute inline this slice',
      },
    };
  }

  // Resolve repoRoot — supports the worktree-aware 'auto' mode (#1330).
  const resolved = await resolveRepoRoot(
    {
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      featureId: args.featureId,
      // Pass taskId so `repoRoot:'auto'` can fall back to the task's
      // worktree.created event when no explicit worktreePath is given — the
      // check_test_adequacy contract. Omitted before, which left 'auto'
      // resolvable only via worktreePath (Seer LOW, PR #1541).
      taskId: args.taskId,
    },
    eventStore,
  );
  if (!resolved.ok) {
    return { success: false, error: { code: 'INVALID_INPUT', message: resolved.error } };
  }
  const repoRoot = resolved.repoRoot;

  // ── Resolve the mutation command (slice 2). Unresolved → Skipped (never a
  // hard fail; mirrors verification-toolchain), naming the remediation. ──────
  const resolve = args.resolve ?? resolveVerificationRuntime;
  let runtime: ResolvedVerificationRuntime;
  try {
    runtime = resolve(repoRoot);
  } catch (err) {
    // A malformed/unreadable .exarchos.yml is a hard failure (DIM-2).
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: err instanceof Error ? err.message : String(err) },
    };
  }
  if (!runtime.mutation) {
    const reason =
      runtime.remediation ??
      'no mutation runner resolved for this repository — install one (e.g. stryker, ' +
        'cargo-mutants, mutmut) or set `mutation:` in .exarchos.yml';
    // DR-2a: emit a skip-passing gate.executed so the projection records
    // `reviews['mutation-adequacy']` as skip-pass. Without this the required
    // dimension is silently absent and `review → synthesize` dead-locks at HIGH
    // tier on a repo that has no mutation runner (INV-1: presence is satisfied
    // by a recorded fact, not by dropping the requirement).
    try {
      await emitGateEvent(
        eventStore,
        args.featureId,
        MUTATION_GATE_NAME,
        MUTATION_GATE_LAYER,
        true,
        { skipped: true, reason, mutationScore: 0 },
        mutationGateKey(args.operationId, 'skip-no-toolchain'),
      );
    } catch (err) {
      // Fire-and-forget — emission failure must not break the advisory verdict,
      // but a dropped no-toolchain skip-pass re-enters the DR-2a dead-lock at
      // review→synthesize, so surface a diagnostic (RVC-R4).
      orchestrateLogger.warn(
        { featureId: args.featureId, err: err instanceof Error ? err.message : String(err) },
        'mutation-adequacy: failed to emit no-toolchain skip-pass gate.executed; dimension may be absent at review→synthesize',
      );
    }
    return {
      success: true,
      data: {
        passed: true,
        skipped: true,
        reason,
        mutationScore: 0,
        killed: 0,
        survived: 0,
        noCoverage: 0,
        total: 0,
      },
    };
  }

  // ── Compose the command. `full` (offline opt-in, DR-6) runs the whole tree —
  // the resolved runner verbatim, NO diff scope. `diff` (the inline default)
  // composes the per-runner diff scope (002). Identity stays in the SoT; the
  // handler is runner-agnostic. ──────────────────────────────────────────────
  const runDiff = args.runDiff ?? defaultRunDiff;
  const scoped: { readonly command: string; readonly warning?: string } =
    scope === 'full'
      ? { command: runtime.mutation }
      : (() => {
          const detect =
            args.detectToolchainId ?? ((root: string) => detectToolchain(root)?.id ?? null);
          const toolchainId = detect(repoRoot) ?? '';
          const diffScope = resolveMutationDiffScope(toolchainId, args.base);
          return composeScopedCommand(runtime.mutation, diffScope, {
            base: args.base,
            repoRoot,
            runDiff,
          });
        })();

  // ── Run (injected seam). Bracket with the INV-10 liveness pair. ────────────
  //
  // DR-2 / DR-3: stamp a canonical `instanceId` on BOTH the start and terminal
  // liveness emissions (mirroring `cli-commands/run-mutation.ts`) so a stuck
  // mutation run is visible to `ps` and waitable via `wait --operation mutation`.
  // Without it the live emitter emitted keyless rows that `computeInFlightInstances`
  // could only pair via the DR-2 legacy singleton — one indistinguishable slot per
  // stream. Reuse the gate `operationId` when present (correlating the liveness
  // pair with the gate.executed row); otherwise mint a fresh per-pass id.
  const runMutation = args.runMutation ?? defaultRunMutation;
  const instanceId = args.operationId ?? randomUUID();
  await emitLiveness(eventStore, args.featureId, 'mutation.executing_started', {
    command: scoped.command,
    repoRoot,
    instanceId,
  });
  // The terminal event must land on EVERY exit path. `defaultRunMutation`
  // handles its own sync failures, but the injected `runMutation` seam can
  // still reject — and an unpaired `mutation.executing_started` pins the run
  // in-flight forever: `ps` reports a phantom executing mutation and
  // `wait --operation mutation` blocks to timeout, because DR-2 liveness
  // pairing resolves an instance only when its terminal event arrives.
  let runResult: MutationRunResult;
  try {
    runResult = await runMutation({ command: scoped.command, repoRoot, base: args.base });
  } catch (err) {
    await emitLiveness(eventStore, args.featureId, 'mutation.executed', {
      command: scoped.command,
      repoRoot,
      passed: false,
      exitCode: 1,
      instanceId,
    });
    throw err;
  }
  await emitLiveness(eventStore, args.featureId, 'mutation.executed', {
    command: scoped.command,
    repoRoot,
    passed: runResult.ok,
    exitCode: runResult.ok ? 0 : 1,
    instanceId,
  });

  // ── Run-level degrade (no parseable report) → Warning, never a throw. ──────
  if (!runResult.ok) {
    await emitAdvisoryGate(eventStore, args, runResult.reason);
    return warningCarrier(runResult.reason, scoped.warning);
  }

  // ── Parse + fold (001). Malformed report → Warning (degrade). ──────────────
  const parsed = parseMutationReport(runResult.report);
  if (!parsed.ok) {
    await emitAdvisoryGate(eventStore, args, parsed.reason);
    return warningCarrier(parsed.reason, scoped.warning);
  }

  const carrier = parsed.carrier;
  const threshold = resolveThreshold(args);
  const passed = carrier.mutationScore >= threshold;
  const nextActions = survivorAffordances(parsed.report);

  // ── Emit the foldable gate.executed (004 / INV-1). Idempotent via an
  // OUTCOME-suffixed operationId key (INV-8, RVC-R7) — NO CAS-pin on the
  // follow-on event. ─────────────────────────────────────────────────────────
  try {
    await emitGateEvent(
      eventStore,
      args.featureId,
      MUTATION_GATE_NAME,
      MUTATION_GATE_LAYER,
      passed,
      {
        mutationScore: carrier.mutationScore,
        killed: carrier.killed,
        survived: carrier.survived,
        noCoverage: carrier.noCoverage,
        total: carrier.total,
        threshold,
      },
      mutationGateKey(args.operationId, 'scored'),
    );
  } catch (err) {
    // Fire-and-forget — emission failure must not break the verdict. A dropped
    // real-score emission leaves the dimension absent, which fails CLOSED at
    // review→synthesize (safe), but still warrants a diagnostic trail (RVC-R4).
    orchestrateLogger.warn(
      { featureId: args.featureId, err: err instanceof Error ? err.message : String(err) },
      'mutation-adequacy: failed to emit scored gate.executed',
    );
  }

  // ── INV-5b advisory carrier. Severity (006) is applied by the dispatch
  // adapter (applyLadderGateSeverity) AFTER this returns. ────────────────────
  return {
    success: true,
    ...(scoped.warning ? { warnings: [scoped.warning] } : {}),
    data: {
      passed,
      mutationScore: carrier.mutationScore,
      killed: carrier.killed,
      survived: carrier.survived,
      noCoverage: carrier.noCoverage,
      total: carrier.total,
      threshold,
      report: parsed.report,
      next_actions: nextActions,
    },
  };
}

/**
 * Idempotency key for a mutation gate.executed emission, suffixed by OUTCOME.
 * `emitGateEvent` collapses same-key re-emissions to one row, so keying every
 * outcome by the bare `operationId` let a skip-pass/degraded row suppress a later
 * scored row for the same run (CodeRabbit RVC-R7). Suffixing by outcome keeps the
 * intended idempotency (a retried SAME-outcome emission still collapses) while
 * letting a different outcome append a fresh row the projection folds
 * last-write-wins. `undefined` when no operationId was threaded (fire-and-forget,
 * one row per call).
 */
function mutationGateKey(
  operationId: string | undefined,
  outcome: 'scored' | 'degraded' | 'skip-no-toolchain',
): string | undefined {
  return operationId === undefined ? undefined : `${operationId}:${outcome}`;
}

/** Resolve the effective threshold: arg override > config > soft default. */
function resolveThreshold(args: MutationAdequacyArgs): number {
  if (typeof args.threshold === 'number') return args.threshold;
  const configured = args.projectConfig?.review.gates[MUTATION_GATE_NAME]?.params?.threshold;
  if (typeof configured === 'number') return configured;
  return DEFAULT_MUTATION_THRESHOLD;
}

/**
 * DR-2a: emit an advisory (passing) `gate.executed` for a degrade path — a
 * toolchain IS present but the runner failed or produced no parseable report.
 * Records `reviews['mutation-adequacy']` as skip-pass so the required dimension
 * is not left absent (a secondary `review → synthesize` dead-lock).
 *
 * The marker is `{ skipped: true, degraded: true }` — deliberately DISTINCT from
 * the no-toolchain skip-pass (`{ skipped: true }`, no `degraded`). Both satisfy
 * the presence requirement and stay advisory by default, but `degraded` lets the
 * `review.mutationEnforcement: 'block'` score gate fail CLOSED on a broken runner
 * (guards.ts `allReviewsPassed` Check 4): a present-but-broken runner produced no
 * verifiable score, so block enforcement must not silently pass it. The
 * no-toolchain case stays advisory even under block mode — it is "a backstop the
 * repo cannot run" (spec §Trade-offs, DR-2a), not a backstop that failed.
 *
 * Fire-and-forget: an emission failure must never break the advisory verdict, but
 * a dropped emission leaves the dimension absent and re-enters the dead-lock, so
 * surface it via the structured logger (stderr — stdout is the MCP protocol).
 */
async function emitAdvisoryGate(
  eventStore: EventStore,
  args: MutationAdequacyArgs,
  reason: string,
): Promise<void> {
  try {
    await emitGateEvent(
      eventStore,
      args.featureId,
      MUTATION_GATE_NAME,
      MUTATION_GATE_LAYER,
      true,
      { skipped: true, degraded: true, reason, mutationScore: 0 },
      mutationGateKey(args.operationId, 'degraded'),
    );
  } catch (err) {
    orchestrateLogger.warn(
      { featureId: args.featureId, err: err instanceof Error ? err.message : String(err) },
      'mutation-adequacy: failed to emit degraded skip-pass gate.executed; dimension may be absent at review→synthesize',
    );
  }
}

/** Build a degraded Warning carrier (a malformed/empty report never throws). */
function warningCarrier(reason: string, scopeWarning?: string): ToolResult {
  const warnings = scopeWarning ? [scopeWarning, reason] : [reason];
  return {
    success: true,
    warnings,
    data: {
      passed: true,
      warning: reason,
      mutationScore: 0,
      killed: 0,
      survived: 0,
      noCoverage: 0,
      total: 0,
    },
  };
}

/**
 * Fire-and-forget liveness emit that never throws into the run path (INV-4
 * degrade) — but never silently, either.
 *
 * The no-throw is deliberate and stays: a liveness-emission failure must not
 * fail a mutation run that actually succeeded, and throwing would not close the
 * gap anyway (a crash between the pair produces the identical unpaired state).
 *
 * The two events are NOT symmetric, though, and the asymmetry is why this logs:
 *   - a lost `mutation.executing_started` is self-healing — no start is
 *     recorded, so no instance is ever considered in-flight;
 *   - a lost `mutation.executed` is NOT — `computeInFlightInstances` is a pure
 *     left-fold with no TTL or age eviction, so the unpaired start reports as
 *     in-flight to `ps` / `wait --operation mutation` until a registry terminal
 *     for its `instanceId` is appended (the S-6 recovery path).
 *
 * That end state is designed-observable and recoverable, not corruption — but an
 * empty `catch {}` threw away the one breadcrumb explaining WHY an instance is
 * stuck. Log it instead, matching the `gate.executed` degrade path's diagnostic
 * trail (RVC-R4) in this same file.
 */
async function emitLiveness(
  store: EventStore,
  stream: string,
  type: 'mutation.executing_started' | 'mutation.executed',
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await store.append(stream, { type, data });
  } catch (err) {
    // Terminal-event loss is the consequential one — say so, and name the
    // instance an operator would otherwise have to reverse-engineer from `ps`.
    const terminal = type === 'mutation.executed';
    orchestrateLogger.warn(
      {
        stream,
        type,
        instanceId: data.instanceId,
        err: err instanceof Error ? err.message : String(err),
        ...(terminal ? { consequence: 'unpaired-start-reports-in-flight' } : {}),
      },
      terminal
        ? 'mutation-adequacy: failed to emit terminal mutation.executed — `ps`/`wait --operation mutation` will report this instance in-flight until a registry terminal is appended for it (S-6 recovery)'
        : 'mutation-adequacy: failed to emit mutation.executing_started — run proceeds untracked',
    );
  }
}
