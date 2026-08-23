// ─── Prepare Synthesis Composite Action ─────────────────────────────────────
//
// The synthesis-readiness gate: task completion, the governed repository's own
// test and typecheck commands, documentation coverage, and branch-stack health.
// Alongside those five it REPORTS where the workflow stands relative to its
// `synthesize` phase, so a caller standing in a review phase learns what is
// still between it and synthesis. Emits gate.executed for the readiness and
// code-quality views.
//
// This action absorbed an orphaned near-duplicate that nothing invoked. Two of
// that module's habits were better than what stood here and were carried over;
// the rest were deliberately left behind. Each decision is recorded beside the
// leg it belongs to rather than in a list here, so it stays true when the leg
// changes.
// ────────────────────────────────────────────────────────────────────────────

import { execSync, execFileSync } from 'node:child_process';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { runCommandSync } from '../../utils/process.js';
import { resolveTestRuntime, type ResolvedRuntime } from '../../config/test-runtime-resolver.js';
import { splitCommand } from '../../config/tokenize-command.js';
import { classifyCommandFailure, inconclusiveReason } from '../pure/command-outcome.js';
import {
  detectToolchain,
  resolveTestReportFormat,
  type TestReportFormat,
} from '../../config/toolchains.js';
import { resolveWorkflowState } from '../resolve-state.js';
import { getHSMDefinition, type HSMDefinition } from '../../workflow/state-machine.js';
import { emitGateEvent } from '../gates/gate-utils.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import { globToRegExp } from '../../architecture/glob-to-regexp.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from '../gates/gate-runner.js';

// ─── Result Types ──────────────────────────────────────────────────────────

interface SynthesisReadinessState {
  tasksComplete: boolean;
  testsPass: boolean;
  typecheckPass: boolean;
  documentReady: boolean;
  stackHealthy: boolean;
}

interface TestResult {
  passed: boolean;
  /**
   * Counts are present only when the resolved runner's carrier reports them.
   * A runner whose whole verdict is its exit code has no counts to report, and
   * a zero there would read as "ran, found nothing" rather than "not reported".
   */
  passCount?: number;
  failCount?: number;
  output?: string;
  /** The leg could not run at all: neither a pass nor a failure was observed. */
  indeterminate?: true;
  reason?: string;
}

interface TypecheckResult {
  passed: boolean;
  errorCount: number;
  errors?: string[];
  /** The leg could not run at all: neither a pass nor a failure was observed. */
  indeterminate?: true;
  reason?: string;
}

interface StackResult {
  healthy: boolean;
  branches?: string[];
  error?: string;
  /** The leg could not run at all: neither a healthy nor an unhealthy stack was observed. */
  indeterminate?: true;
  reason?: string;
}

interface PrepareSynthesisResult {
  ready: boolean;
  readiness: SynthesisReadinessState;
  blockers?: string[];
  tests: TestResult;
  typecheck: TypecheckResult;
  document: DocumentLegResult;
  stack: StackResult;
  /** Where the workflow stands relative to `synthesize`. Reported, never blocking. */
  phase: PhaseReadiness;
  /**
   * The carrier's own statement that it could not run to a conclusion.
   *
   * `prepare_synthesis` is a registered gate class, so this action's result
   * really does reach `readGateSkipDescriptor` through the canonical runner,
   * where it becomes an `indeterminate` verdict instead of a readiness answer
   * the gate never computed. Set only when a leg went UNMEASURED and no other
   * leg failed — an observed failure is a finding, and must stay one.
   */
  skipped?: true;
  reason?: string;
}

// ─── Phase Readiness ───────────────────────────────────────────────────────

const SYNTHESIZE_PHASE = 'synthesize';

/** One hop on the way to `synthesize`, named with the guard that opens it. */
export interface PhaseTransitionStep {
  readonly from: string;
  readonly to: string;
  readonly guard?: string;
}

/**
 * Where the workflow stands relative to its `synthesize` phase.
 *
 * Derived from the workflow type's OWN state machine, never from a table of
 * phase names kept here. The absorbed predecessor carried such a table —
 * eighteen literal phase ids under cases for three workflow types, and a
 * `default:` arm that failed everything else — so `oneshot`, which has a real
 * SYNTHESIZE phase, could never pass it, and `discovery`, which has no
 * synthesize phase at all, was told it had FAILED rather than that the question
 * did not apply to it. A machine that gains a phase, or a workflow type
 * registered at runtime, is covered here by construction.
 *
 * REPORTED, never blocking. This action is registered for the review phases as
 * well as `synthesize`, so "not there yet" is its ordinary calling condition
 * rather than a finding; blocking on it would make the gate fail in three of
 * the four phases it is registered for. Refusing an illegal move is the
 * transition guards' job — this leg only says which moves are left.
 */
export type PhaseReadiness =
  | { readonly kind: 'at-synthesize' }
  | { readonly kind: 'reachable'; readonly transitions: readonly PhaseTransitionStep[] }
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'not-applicable'; readonly reason: string };

/**
 * Fewest transitions from `from` to `to`, or `null` when the target is not
 * reachable. Breadth-first, so a fix-cycle edge back to an earlier phase can
 * never lengthen the answer.
 */
function shortestTransitionPath(
  hsm: HSMDefinition,
  from: string,
  to: string,
): readonly PhaseTransitionStep[] | null {
  if (hsm.states[from] === undefined) return null;
  const arrivedBy = new Map<string, PhaseTransitionStep>();
  const seen = new Set<string>([from]);
  const queue: string[] = [from];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === to) break;
    for (const transition of hsm.transitions) {
      if (transition.from !== current || seen.has(transition.to)) continue;
      seen.add(transition.to);
      arrivedBy.set(transition.to, {
        from: transition.from,
        to: transition.to,
        ...(transition.guard ? { guard: transition.guard.id } : {}),
      });
      queue.push(transition.to);
    }
  }

  const path: PhaseTransitionStep[] = [];
  let cursor = to;
  while (cursor !== from) {
    const step = arrivedBy.get(cursor);
    if (step === undefined) return null;
    path.unshift(step);
    cursor = step.from;
  }
  return path;
}

/**
 * Ask the workflow type's state machine how far the current phase is from
 * synthesis. Exported for direct testing: it is pure, and its whole value is
 * that it holds no phase names of its own.
 */
export function assessPhaseReadiness(
  workflowType: string,
  phase: string,
  hsm?: HSMDefinition,
): PhaseReadiness {
  let machine: HSMDefinition;
  try {
    machine = hsm ?? getHSMDefinition(workflowType);
  } catch {
    return {
      kind: 'not-applicable',
      reason:
        `'${workflowType}' has no registered state machine, so the path to ` +
        `'${SYNTHESIZE_PHASE}' cannot be derived`,
    };
  }

  if (machine.states[SYNTHESIZE_PHASE] === undefined) {
    return {
      kind: 'not-applicable',
      reason: `the '${workflowType}' workflow has no '${SYNTHESIZE_PHASE}' phase`,
    };
  }
  if (phase === SYNTHESIZE_PHASE) return { kind: 'at-synthesize' };

  const transitions = shortestTransitionPath(machine, phase, SYNTHESIZE_PHASE);
  if (transitions === null) {
    return {
      kind: 'unreachable',
      reason:
        `no transition path runs from '${phase}' to '${SYNTHESIZE_PHASE}' in the ` +
        `'${workflowType}' workflow`,
    };
  }
  return { kind: 'reachable', transitions };
}

// ─── Verification-Leg Resolution ───────────────────────────────────────────
//
// The tests and typecheck legs run the GOVERNED repository's own commands.
// Which commands those are is a toolchain fact, so it is resolved from the
// toolchain source of truth rather than spelled here: a literal package-manager
// invocation makes both legs undischargeable on any repository that is not a
// Node one, and this gate blocks synthesis.
//
// A repository whose runtime does not resolve gets NO verdict — not a pass, and
// not a skip that reads as green. That is the `indeterminate` arm.

/** Commands to run, plus how to read what the test runner prints. */
interface ResolvedLegs {
  readonly kind: 'resolved';
  readonly test: string;
  /** `null` when the resolved toolchain has no typecheck step at all. */
  readonly typecheck: string | null;
  readonly carrier: TestReportFormat;
}

interface UnresolvedLegs {
  readonly kind: 'indeterminate';
  readonly reason: string;
}

type LegResolution = ResolvedLegs | UnresolvedLegs;

/**
 * How the resolved test runner reports its result.
 *
 * Consulted only when the command came from built-in DETECTION. Every other
 * layer — an override, `.exarchos.yml`, a user-declared toolchain, a committed
 * task runner — supplies a command the built-in carrier table says nothing
 * about, and reading a detected toolchain's row for it would attribute one
 * runner's output grammar to another.
 */
function resolveCarrier(repoRoot: string, runtime: ResolvedRuntime): TestReportFormat {
  if (runtime.source !== 'detection') {
    return {
      kind: 'unknown',
      reason:
        `the test command was supplied by '${runtime.source}' rather than by toolchain ` +
        'detection, so how its runner reports a result is unknown',
    };
  }
  return resolveTestReportFormat(detectToolchain(repoRoot)?.id ?? '');
}

function resolveLegs(repoRoot: string): LegResolution {
  let runtime: ResolvedRuntime;
  try {
    runtime = resolveTestRuntime(repoRoot);
  } catch (err) {
    return { kind: 'indeterminate', reason: err instanceof Error ? err.message : String(err) };
  }
  if (runtime.source === 'unresolved' || runtime.test === null) {
    return {
      kind: 'indeterminate',
      reason:
        runtime.remediation ??
        `no test command resolves for '${repoRoot}', so the suite could not be run`,
    };
  }
  return {
    kind: 'resolved',
    test: runtime.test,
    typecheck: runtime.typecheck,
    carrier: resolveCarrier(repoRoot, runtime),
  };
}

// ─── Command Execution ─────────────────────────────────────────────────────

/**
 * `repoRoot` is threaded as `cwd` on every leg below: the process this MCP
 * server happens to have been launched in is never an implicit scan surface —
 * the caller must name the tree it wants judged.
 */
interface CommandOutcome {
  readonly ok: boolean;
  readonly text: string;
  /**
   * Set when the run produced no verdict — the command could not be started,
   * or it was killed at its wall clock. `ok: false` alone would make both read
   * as a leg that ran and failed.
   */
  readonly inconclusive?: string;
}

function decodeStreams(chunks: readonly unknown[]): string {
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk;
      if (chunk instanceof Buffer) return chunk.toString('utf-8');
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Run a resolved command in `repoRoot`. argv form, not a shell string: the
 * resolver's command may carry quoted arguments, and a shell would also give a
 * crafted `.exarchos.yml` value somewhere to hide. `runCommandSync` is what
 * still launches a package-manager `.cmd` shim on Windows.
 */
function runResolvedCommand(
  command: string,
  repoRoot: string,
  timeoutMs: number,
): CommandOutcome {
  let cmd: string;
  let args: readonly string[];
  try {
    ({ cmd, args } = splitCommand(command));
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { ok: false, text, inconclusive: `\`${command}\` is not tokenizable: ${text}` };
  }
  if (cmd === '') {
    return {
      ok: false,
      text: `empty command: '${command}'`,
      inconclusive: `\`${command}\` resolves to no executable`,
    };
  }
  try {
    const output = runCommandSync(cmd, args, {
      cwd: repoRoot,
      encoding: 'buffer',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, text: decodeStreams([output]) };
  } catch (err: unknown) {
    const failure = classifyCommandFailure(err);
    const text = decodeStreams([failure.stdout, failure.stderr]);
    const reason = inconclusiveReason(command, failure);
    return {
      ok: false,
      text: text === '' && reason !== null ? reason : text,
      ...(reason === null ? {} : { inconclusive: reason }),
    };
  }
}

// ─── Test Runner ───────────────────────────────────────────────────────────

function runTestSuite(repoRoot: string, legs: ResolvedLegs): TestResult {
  const outcome = runResolvedCommand(legs.test, repoRoot, 120_000);
  if (outcome.inconclusive !== undefined) {
    // The suite was not observed. Counts scraped from a truncated or empty
    // transcript would be counts of nothing, so none are reported.
    return { passed: false, indeterminate: true, reason: outcome.inconclusive, output: outcome.text };
  }
  return {
    passed: outcome.ok,
    ...parseTestOutput(outcome.text, legs.carrier),
    output: outcome.text,
  };
}

/**
 * Pass/fail counts, when the carrier says the runner prints them in a shape
 * this parse understands. Anything else reports no counts rather than a count
 * scraped out of a grammar it was never written for — the verdict itself comes
 * from the exit code, which every runner carries honestly.
 */
function parseTestOutput(
  output: string,
  carrier: TestReportFormat,
): { passCount?: number; failCount?: number } {
  if (carrier.kind !== 'vitest-json') return {};
  const passMatch = output.match(/(\d+)\s+passed/);
  const failMatch = output.match(/(\d+)\s+failed/);
  return {
    passCount: passMatch ? parseInt(passMatch[1] ?? '0', 10) : 0,
    failCount: failMatch ? parseInt(failMatch[1] ?? '0', 10) : 0,
  };
}

// ─── Typecheck Runner ──────────────────────────────────────────────────────

function runTypecheck(repoRoot: string, legs: ResolvedLegs): TypecheckResult {
  // A null typecheck command is the RESOLVER'S OWN 'unresolved' answer for that
  // field, not a project's withdrawal of the obligation. Reading it as a
  // withdrawal turned every repository the resolver could not answer for into a
  // green typecheck leg — proof minted from an absence. Only an explicit
  // `typecheck:` in `.exarchos.yml` (or an override) discharges this leg; until
  // one exists the obligation stands, unmeasured.
  if (legs.typecheck === null) {
    return {
      passed: false,
      errorCount: 0,
      indeterminate: true,
      reason:
        `no typecheck command resolves for '${repoRoot}'. Declare one under ` +
        '`typecheck:` in .exarchos.yml, or pass an override.',
    };
  }
  const outcome = runResolvedCommand(legs.typecheck, repoRoot, 60_000);
  if (outcome.ok) return { passed: true, errorCount: 0 };
  if (outcome.inconclusive !== undefined) {
    return { passed: false, errorCount: 0, indeterminate: true, reason: outcome.inconclusive };
  }
  const errors = parseTypecheckErrors(outcome.text);
  return { passed: false, errorCount: errors.length, errors };
}

/**
 * Diagnostic lines from a failed typecheck. TypeScript's `error TS….` prefix is
 * recognized because it lets the count mean something; any other compiler's
 * output is reported whole rather than counted as zero errors on a leg that
 * demonstrably failed.
 */
function parseTypecheckErrors(output: string): string[] {
  const errorLines = output.split('\n').filter((line) => line.includes('error TS'));
  return errorLines.length > 0 ? errorLines : output.trim() ? [output.trim()] : [];
}

// ─── Default Branch Detection ─────────────────────────────────────────────

function detectDefaultBranch(repoRoot: string): string {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const branch = ref.replace('refs/remotes/origin/', '');
    // Sanitize to prevent command injection via crafted ref names
    return /^[a-zA-Z0-9/_.-]+$/.test(branch) ? branch : 'main';
  } catch {
    return 'main';
  }
}

// ─── Stack Verifier ────────────────────────────────────────────────────────

/**
 * Whether there is anything to synthesize: commits on HEAD that the base branch
 * does not have. That is a VERSION-CONTROL question, so it is asked of git
 * directly. Whether a pull request exists on the host for this branch is a
 * different obligation with its own gate, sequenced immediately after this
 * action in the synthesis runbook — asking it here would duplicate the very
 * next step, and would make a repository on a non-GitHub host need a skip this
 * leg has no reason to want.
 *
 * A git failure is NOT an unhealthy stack. This is the half of the absorbed
 * predecessor worth keeping: it recorded a leg it could not run as unrun rather
 * than as failed. An EMPTY commit range is a finding — nothing has been built
 * yet — but a range that could not be resolved establishes nothing at all, and
 * the two were previously indistinguishable at `healthy: false`.
 */
function verifyStack(repoRoot: string): StackResult {
  const range = `${detectDefaultBranch(repoRoot)}..HEAD`;
  try {
    const output = execSync(`git log --oneline --graph ${range}`, {
      cwd: repoRoot,
      encoding: 'buffer',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const text = output.toString('utf-8');
    const branches = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return { healthy: branches.length > 0, branches };
  } catch (err: unknown) {
    const command = `git log ${range}`;
    const failure = classifyCommandFailure(err);
    // A non-zero exit from `git log <range>` is not a verdict about the stack
    // either: it means the RANGE did not resolve (an unknown base ref, or no
    // repository here), so the leg was never scoped.
    const reason =
      inconclusiveReason(command, failure) ??
      `\`${command}\` could not resolve the commit range (${failure.detail}), ` +
        'so the stack was not measured';
    return { healthy: false, branches: [], error: failure.detail, indeterminate: true, reason };
  }
}

// ─── Document-Readiness Leg (#1594) ─────────────────────────────────────────

export type DocumentLegConfig = ResolvedProjectConfig['synthesis']['documentLeg'];

/**
 * Behavior-neutral default when no resolved config is threaded (e.g. a unit
 * test invoking the handler without `projectConfig`): advisory severity + empty
 * surface globs ⇒ the leg auto-waives, so the absence of config is never a
 * blocker.
 */
const DEFAULT_DOCUMENT_LEG: DocumentLegConfig = {
  severity: 'advisory',
  surfaceGlobs: [],
  docGlobs: ['docs/**', '**/*.md'],
};

export interface DocumentLegResult {
  /** false ⇒ auto-waived: no doc-bearing surface was touched. */
  readonly evaluated: boolean;
  /** docs changed (or auto-waived). false ⇒ a doc-bearing surface changed with no doc update. */
  readonly covered: boolean;
  readonly severity: 'advisory' | 'blocking';
  readonly surfaceFiles: readonly string[];
  readonly message?: string;
}

/**
 * Evaluate the `document` readiness leg structurally: when the changeset touches
 * a configured doc-bearing surface, a configured doc path must also have changed
 * — otherwise the leg is uncovered. Pure: the caller supplies the changed-file
 * list (from `git diff --name-only`), so the rule itself is deterministic and
 * directly testable. No doc-bearing surface touched ⇒ auto-waive (the
 * no-ceremony default for ordinary changes). No workflow-type branch — the
 * same rule holds for every workflow type.
 */
export function evaluateDocumentLeg(
  files: readonly string[],
  cfg: DocumentLegConfig,
): DocumentLegResult {
  const matchesAny = (globs: readonly string[], f: string): boolean =>
    globs.some((g) => globToRegExp(g).test(f));
  const surfaceFiles = files.filter((f) => matchesAny(cfg.surfaceGlobs, f));
  if (surfaceFiles.length === 0) {
    return { evaluated: false, covered: true, severity: cfg.severity, surfaceFiles: [] };
  }
  const docsChanged = files.some((f) => matchesAny(cfg.docGlobs, f));
  if (docsChanged) {
    return { evaluated: true, covered: true, severity: cfg.severity, surfaceFiles };
  }
  return {
    evaluated: true,
    covered: false,
    severity: cfg.severity,
    surfaceFiles,
    message:
      `Doc-bearing surface changed without a documentation update: ${surfaceFiles.join(', ')}. ` +
      `Update the relevant docs, or tune synthesis.documentLeg in .exarchos.yml to waive.`,
  };
}

/**
 * Whether the document leg BLOCKS synthesis readiness. Only a `'blocking'`
 * severity on an evaluated-and-uncovered leg blocks; an advisory uncovered leg
 * still records `gate.executed { passed:false }` (visible) but does not block.
 */
export function documentLegBlocks(result: DocumentLegResult): boolean {
  return result.evaluated && !result.covered && result.severity === 'blocking';
}

/**
 * Changed files between the default base branch and HEAD (name-only). Returns
 * `null` — NOT `[]` — when git detection fails, so the document-leg caller can
 * tell "no surface changed" apart from "couldn't determine" and fail CLOSED on
 * the latter rather than silently auto-waiving a blocking leg. argv-form
 * `execFileSync` (not shell-form `execSync`) eliminates the shell surface even
 * though `baseBranch` is already sanitized by `detectDefaultBranch`.
 */
function changedFilesAgainstBase(repoRoot: string): string[] | null {
  try {
    const baseBranch = detectDefaultBranch(repoRoot);
    const output = execFileSync('git', ['diff', '--name-only', `${baseBranch}...HEAD`], {
      cwd: repoRoot,
      encoding: 'buffer',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output
      .toString('utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

// ─── Task Readiness Check ──────────────────────────────────────────────────

/** Minimal shape of a task entry in the canonical workflow-state projection. */
interface ResolvedTaskEntry {
  readonly id: string;
  readonly status: string;
}

function checkTaskCompletion(
  tasks: readonly ResolvedTaskEntry[],
): { allComplete: boolean; blockers: string[] } {
  if (tasks.length === 0) {
    return { allComplete: true, blockers: [] };
  }

  const blockers: string[] = [];
  for (const task of tasks) {
    // #1536: the canonical workflowStateProjection uses status 'complete' (not
    // 'completed' — the value the old task-detail materializer used). Matching
    // the canonical value here is what keeps readiness in lock-step with
    // exarchos_workflow get and eliminates phantom in-progress blockers.
    if (task.status !== 'complete') {
      blockers.push(`Task '${task.id}' is ${task.status}`);
    }
  }

  return { allComplete: blockers.length === 0, blockers };
}

// ─── Handler ───────────────────────────────────────────────────────────────

/**
 * `repoRoot` is REQUIRED, not defaulted (#1756). With no field naming the tree
 * a readiness verdict was for,
 * so every subprocess leg silently measured the ambient `process.cwd()` the
 * MCP server happened to be launched in. A required field makes an
 * unrelated-tree verdict a compile-time impossibility for every in-repo
 * caller, and {@link executePrepareSynthesis} additionally refuses at
 * runtime (INVALID_INPUT) rather than falling back to `process.cwd()` for
 * any caller that reaches the handler through an unchecked cast.
 */
interface PrepareSynthesisArgs {
  readonly featureId: string;
  readonly repoRoot: string;
  readonly projectConfig?: ResolvedProjectConfig;
}

export async function handlePrepareSynthesis(
  args: PrepareSynthesisArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  return runPhaseGateWithEvidence({
    streamId: args.featureId,
    gateClass: 'prepare-synthesis',
    requirementId: 'requirement:prepare-synthesis',
    stateDir,
    eventStore,
    subject: (phaseAttemptId) => createEvidenceSubject(
      { kind: 'phase-attempt', phaseAttemptId },
      { gate: 'prepare-synthesis' },
    ),
    providerInput: args,
    executeProvider: async () => executePrepareSynthesis(args, stateDir, eventStore),
  });
}

async function executePrepareSynthesis(
  args: PrepareSynthesisArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  // 1. Validate input
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  const streamId = args.featureId;

  try {
    const store = eventStore;

    // 2. Resolve task status from the CANONICAL source — resolveWorkflowState,
    //    the same event-store projection exarchos_workflow get reads (#1536).
    //    The old task-detail materializer could fold a divergent task array
    //    (phantom in-progress), phantom-blocking synthesis on tasks the
    //    canonical state showed complete.
    const resolved = await resolveWorkflowState({ featureId: streamId, eventStore: store });
    if ('error' in resolved) {
      return resolved.error;
    }
    const tasks = (resolved.state.tasks as ResolvedTaskEntry[] | undefined) ?? [];

    // 2b. How far the workflow is from `synthesize`, per its own state machine.
    //     Reported on every path below, including the early return: a caller
    //     told "not ready" is owed the reason it is standing where it is.
    const phase = assessPhaseReadiness(
      typeof resolved.state['workflowType'] === 'string' ? resolved.state['workflowType'] : 'feature',
      typeof resolved.state['phase'] === 'string' ? resolved.state['phase'] : 'unknown',
    );

    // 3. Check task completion — early return if tasks not all complete.
    //    An EMPTY task list is complete, not a failure: a workflow that
    //    delegated nothing (a oneshot, say) has nothing outstanding, and the
    //    absorbed predecessor's "no tasks found" failure made every such
    //    workflow unsynthesizable.
    const { allComplete, blockers } = checkTaskCompletion(tasks);
    if (!allComplete) {
      const readiness: SynthesisReadinessState = {
        tasksComplete: false,
        testsPass: false,
        typecheckPass: false,
        documentReady: false,
        stackHealthy: false,
      };

      const result: PrepareSynthesisResult = {
        ready: false,
        readiness,
        blockers,
        tests: { passed: false, passCount: 0, failCount: 0 },
        typecheck: { passed: false, errorCount: 0 },
        document: { evaluated: false, covered: false, severity: 'advisory', surfaceFiles: [] },
        stack: { healthy: false },
        phase,
      };

      return { success: true, data: result };
    }

    // 3b. #1756: from here on every leg shells out and must be told
    //     which tree to measure. Refuse rather than silently falling back to
    //     the server's own ambient `process.cwd()` — a verdict about the
    //     wrong repo is worse than no verdict. (Deliberately checked AFTER
    //     the task-completion short-circuit above, so a not-ready-on-tasks
    //     verdict — which never runs a leg — is unaffected by this guard.)
    if (!args.repoRoot) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message:
            'repoRoot is required: prepare_synthesis shells out to the test suite, ' +
            'typecheck, stack, and changed-files legs, and refuses to guess which ' +
            "repository they run against — it will not fall back to the server's " +
            'own process.cwd().',
        },
      };
    }
    // …and present is not the same as usable. A RELATIVE `repoRoot` resolves
    // against the server process when it reaches a subprocess as `cwd`, which
    // is the ambient-cwd fallback this guard just refused, spelled differently:
    // `repoRoot: '.'` would satisfy the check above and still measure whatever
    // tree the server is sitting in. The schema rejects these at dispatch; this
    // is the same rule at the handler, for the direct (non-dispatch) callers.
    //
    // The `typeof` half comes first because `RegExp.test()` coerces its
    // argument: `['/repo']` stringifies to `/repo`, clears the shape check, and
    // reaches a subprocess as a non-string `cwd` — which surfaces as
    // PREPARE_SYNTHESIS_FAILED, misreporting a caller's malformed input as a
    // failure of the run.
    if (
      typeof args.repoRoot !== 'string' ||
      !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(args.repoRoot)
    ) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message:
            'repoRoot must be an absolute path, received ' +
            (typeof args.repoRoot === 'string'
              ? `'${args.repoRoot}'`
              : `a ${typeof args.repoRoot}`) +
            ". A relative path resolves against the server's own working directory, so " +
            'the legs would measure a repository the caller never named.',
        },
      };
    }
    const repoRoot = args.repoRoot;

    // 4. Resolve the two command legs from the toolchain source of truth, then
    //    run them. An unresolvable runtime runs nothing and concludes nothing.
    const legs = resolveLegs(repoRoot);

    const tests: TestResult = legs.kind === 'resolved'
      ? runTestSuite(repoRoot, legs)
      : { passed: false, indeterminate: true, reason: legs.reason };

    // 5. Emit gate.executed event for test-suite (feeds flywheel)
    await emitGateEvent(store, streamId, 'test-suite', 'CI', tests.passed, {
      dimension: 'D1',
      phase: 'synthesize',
      ...(tests.passCount !== undefined ? { passCount: tests.passCount } : {}),
      ...(tests.failCount !== undefined ? { failCount: tests.failCount } : {}),
      ...(tests.indeterminate ? { indeterminate: true, reason: tests.reason } : {}),
    });

    // 6. Run typecheck
    const typecheck: TypecheckResult = legs.kind === 'resolved'
      ? runTypecheck(repoRoot, legs)
      : { passed: false, errorCount: 0, indeterminate: true, reason: legs.reason };

    // 7. Emit gate.executed event for typecheck (feeds flywheel)
    await emitGateEvent(store, streamId, 'typecheck', 'CI', typecheck.passed, {
      dimension: 'D1',
      phase: 'synthesize',
      errorCount: typecheck.errorCount,
      errors: typecheck.errors,
      ...(typecheck.indeterminate ? { indeterminate: true } : {}),
      ...(typecheck.reason !== undefined ? { reason: typecheck.reason } : {}),
    });

    // 8. Verify branch stack
    const stack = verifyStack(repoRoot);

    // 9. Evaluate the document-readiness leg (#1594) and emit its gate.
    //    Roster order is task-completion→tests→typecheck→document→stack; gate
    //    EMISSION order here is immaterial (the readiness view folds
    //    gate.executed by name), so the leg is evaluated after the stack check.
    //    `passed` reflects structural coverage; whether an uncovered leg BLOCKS
    //    readiness is the severity decision (documentLegBlocks).
    const docCfg = args.projectConfig?.synthesis?.documentLeg ?? DEFAULT_DOCUMENT_LEG;
    const changedFiles = changedFilesAgainstBase(repoRoot);
    // Fail CLOSED when git detection is unavailable: report the leg as
    // evaluated-but-uncovered so a `blocking` severity blocks readiness instead
    // of being silently auto-waived (an empty-list waive would bypass the gate).
    // An `advisory` leg still only records a visible `gate.executed{passed:false}`.
    const documentLeg: DocumentLegResult = changedFiles === null
      ? {
          evaluated: true,
          covered: false,
          severity: docCfg.severity,
          surfaceFiles: [],
          message:
            'Changed-file detection failed (git unavailable); document-readiness leg '
            + 'could not be verified. Re-run synthesis, or waive via synthesis.documentLeg.',
        }
      : evaluateDocumentLeg(changedFiles, docCfg);
    await emitGateEvent(store, streamId, 'document-coverage', 'synthesize', documentLeg.covered, {
      dimension: 'D1',
      phase: 'synthesize',
      evaluated: documentLeg.evaluated,
      severity: documentLeg.severity,
      surfaceFiles: documentLeg.surfaceFiles,
      ...(documentLeg.message !== undefined ? { message: documentLeg.message } : {}),
    });

    // 10. Build readiness state
    const readiness: SynthesisReadinessState = {
      tasksComplete: allComplete,
      testsPass: tests.passed,
      typecheckPass: typecheck.passed,
      documentReady: !documentLegBlocks(documentLeg),
      stackHealthy: stack.healthy,
    };

    const ready = readiness.tasksComplete
      && readiness.testsPass
      && readiness.typecheckPass
      && readiness.documentReady
      && readiness.stackHealthy;

    const allBlockers: string[] = [];
    const unmeasured: string[] = [];
    if (tests.indeterminate) {
      const why = tests.reason ?? 'no test command resolved';
      unmeasured.push(`Test suite: ${why}`);
      allBlockers.push(`Test suite could not be run — ${why}`);
    } else if (!readiness.testsPass) {
      allBlockers.push('Test suite failed');
    }
    if (typecheck.indeterminate) {
      const why = typecheck.reason ?? 'no typecheck command resolved';
      unmeasured.push(`Typecheck: ${why}`);
      allBlockers.push(`Typecheck could not be run — ${why}`);
    } else if (!readiness.typecheckPass) {
      allBlockers.push('Typecheck failed');
    }
    if (!readiness.documentReady) {
      allBlockers.push(documentLeg.message ?? 'Documentation not updated for a doc-bearing change');
    }
    if (stack.indeterminate) {
      const why = stack.reason ?? 'the commit range could not be resolved';
      unmeasured.push(`Stack: ${why}`);
      allBlockers.push(`Stack health could not be determined — ${why}`);
    } else if (!readiness.stackHealthy) {
      allBlockers.push('Stack not healthy');
    }

    // An unmeasured leg makes the readiness answer unavailable rather than
    // negative — but only while nothing else actually FAILED. A gate that
    // observed a failure has produced a finding, and declaring itself skipped
    // would erase the one thing it did establish.
    const observedFailure =
      !readiness.tasksComplete
      || (!tests.indeterminate && !readiness.testsPass)
      || (!typecheck.indeterminate && !readiness.typecheckPass)
      || !readiness.documentReady
      || (!stack.indeterminate && !readiness.stackHealthy);
    const unconcluded = unmeasured.length > 0 && !observedFailure;

    const result: PrepareSynthesisResult = {
      ready,
      readiness,
      ...(allBlockers.length > 0 ? { blockers: allBlockers } : {}),
      tests,
      typecheck,
      document: documentLeg,
      stack,
      phase,
      ...(unconcluded ? { skipped: true as const, reason: unmeasured.join('; ') } : {}),
    };

    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'PREPARE_SYNTHESIS_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
