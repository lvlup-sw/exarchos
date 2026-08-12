// ─── check_mock_boundary handler (task 026) ──────────────────────────────────
//
// Orchestrate action that runs the mock-boundary gate (SIV-4 #1530) for a
// task's diff and persists canonical subject-bound evidence. The detection itself lives in
// the PURE core `mock-boundary.ts` (`detectMockFindings` — identifier-boundary
// detection + ownership cross-reference); this handler wires the production
// seams:
//   • resolve repoRoot (supports the worktree-aware 'auto' mode, #1330)
//   • compute the task diff (branch vs merge-base — the same `baseRef...HEAD`
//     seam `check_test_adequacy` / `check_contract_drift` use) and parse it into
//     the `FileDiff[]` shape the pure core consumes (post-image line numbers)
//   • resolve `ownership.firstParty` globs from `.exarchos.yml`
//   • resolve this gate's severity (advisory-by-default via DEFAULTS.review.gates,
//     like the other advisory ladder gates; a project review-gate override still wins)
//   • persist evidence with trusted-operation idempotency (INV-8)
//
// The result is an INV-5b advisory carrier: success:true with data.passed
// reflecting the gate verdict, never an error envelope for a mock finding (an
// unowned mock is a finding, not a tool error).
//
// ESCAPE HATCH (enforced default, not an absolute). When the caller passes an
// explicit `reason` acknowledging an intentional unowned mock, the gate passes
// advisory regardless of severity AND durable evidence records the
// acknowledgement + reason. The finding is still surfaced — the escape hatch
// suppresses the verdict, not the evidence.
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import type { EventStore } from '../events/store.js';
import { defaultGitExec, resolvePolicySkip, SKIPPED_BY_POLICY } from './gate-utils.js';
import { runGatePreflight } from './pure/gate-preflight.js';
import { runDurableGateProducer } from './durable-gate-producer.js';
import type { RiskTier } from '../workflow/verification-policy.js';
import { resolveGateSeverity } from './gate-severity.js';
import { DEFAULTS, resolveConfig, type ResolvedProjectConfig } from '../config/resolve.js';
import { loadExarchosConfig, type LoadResult } from '../config/load-exarchos-config.js';
import type { GitExec } from './pure/execute-merge.js';
import {
  detectMockFindings,
  type FileDiff,
  type AddedLine,
  type MockFinding,
} from './mock-boundary.js';
import {
  classifyHermeticDependency,
  resolveHermeticDouble,
} from '../config/toolchains.js';

// ─── The per-finding steer (task 026, INV-12; SIV-5 resolution #1531) ─────────

/**
 * Build the per-finding steer for an UNOWNED mock. INV-12: a gate's next action
 * must name WHAT to do, not just that something is wrong.
 *
 * SIV-5 (#1531): the steer is the constructive target of SIV-4's detection. When
 * the mocked dependency classifies into a known class (DB / cloud-API /
 * message-broker / third-party-HTTP), it resolves to the CONCRETE hermetic
 * double (Testcontainers / LocalStack / Pact-verified stub …) with its
 * fidelity, cadence, and honesty caveat — so the agent gets a specific
 * remediation, not a generic menu. An UNCLASSIFIED dependency falls back to the
 * generic hermetic menu (resolve, don't guess a double).
 */
export function steerForFinding(finding: MockFinding): string {
  const depClass = classifyHermeticDependency(finding.mockedTarget);
  if (depClass !== null) {
    const d = resolveHermeticDouble(depClass);
    return (
      `replace the mock of \`${finding.mockedTarget}\` (${depClass}) with ` +
      `${d.double} [fidelity: ${d.fidelity}; cadence: ${d.cadence}]` +
      (d.caveat ? ` — ${d.caveat}` : '') +
      ` — mocking an unowned dependency asserts against a fiction (the mock ` +
      `cannot be checked against the real contract)`
    );
  }
  return (
    `replace the mock of \`${finding.mockedTarget}\` with a hermetic fixture / ` +
    `contract-verified stub / a fake — mocking an unowned dependency asserts ` +
    `against a fiction (the mock cannot be checked against the real contract)`
  );
}

// ─── Args ────────────────────────────────────────────────────────────────────

export interface MockBoundaryHandlerArgs {
  readonly featureId: string;
  readonly taskId: string;
  /** The task branch (HEAD side of the diff). Defaults to the current branch. */
  readonly branch?: string;
  /** Base ref the branch diverged from (merge-base target). Defaults to 'main'. */
  readonly baseBranch?: string;
  /**
   * Repo to check. A literal path is used verbatim; `'auto'` resolves the
   * calling delegation's agent worktree (#1330); omitting it → process.cwd().
   */
  readonly repoRoot?: string;
  /** Explicit agent worktree path — preferred resolver seam for 'auto'. */
  readonly worktreePath?: string;
  /** Legacy field; evidence idempotency uses trusted DispatchContext only. */
  readonly operationId?: string;
  /**
   * Escape hatch: a reason acknowledging an intentional unowned mock. When
   * present and non-empty, the gate passes advisory regardless of severity, and
   * the acknowledgement is recorded in durable evidence. An enforced
   * default (steer agents away from unowned mocks), NOT an absolute prohibition.
   */
  readonly reason?: string;

  // ── Verification-ladder routing stamp (FIX-1a) ───────────────────────────
  /**
   * The task's stamped risk tier. When provided together with
   * {@link boundaryTouching}, the handler self-skips when the resolved
   * verification sequence does not include this gate (`skipped-by-policy`).
   * Absent (legacy callers) → the gate runs unconditionally.
   */
  readonly riskTier?: RiskTier;
  /** The task's stamped boundary-touching flag. See {@link riskTier}. */
  readonly boundaryTouching?: boolean;
  /**
   * The resolved project config (task 004). Threaded by the dispatch adapter so
   * the self-skip routing consumes the SAME config-resolved policy the
   * delegation stamp uses. Distinct from the per-worktree {@link loadConfig}
   * seam (ownership globs / review-gate severity): this is the dispatch-time
   * config that drives the policy SEQUENCE. Omitted → the resolver falls
   * through to the built-in table.
   */
  readonly projectConfig?: ResolvedProjectConfig;

  // ── Test seams (DI; production defaults below) ───────────────────────────
  readonly gitExec?: GitExec;
  /** Config loader for ownership globs + review-gate severity. */
  readonly loadConfig?: (worktreePath: string) => LoadResult | null;
}

// ─── Production seams ──────────────────────────────────────────────────────
//
// `defaultGitExec` is shared from gate-utils (FIX-4 dedupe) — it was byte-
// identical across the three per-task gate handlers.

// ─── unified-diff → FileDiff[] (post-image line numbers) ─────────────────────

const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a unified `git diff baseRef...HEAD` into the {@link FileDiff} shape the
 * pure core consumes: one entry per changed file, carrying only the ADDED lines
 * with their post-image (new-side) line numbers. The detector scans added
 * content only — a mock the diff DELETES is not a new mock and is never flagged.
 *
 * Tracks the post-image cursor from each `@@ … +c,d @@` hunk header, advancing
 * on added (`+`) and context (` `) lines and skipping removed (`-`) lines.
 */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let currentPath: string | undefined;
  let currentAdded: AddedLine[] = [];
  let newLine = 0;

  const flush = (): void => {
    if (currentPath !== undefined) {
      files.push({ path: currentPath, addedLines: currentAdded });
    }
  };

  for (const raw of diff.split('\n')) {
    const fileMatch = raw.match(DIFF_GIT_RE);
    if (fileMatch) {
      flush();
      // Prefer the b/ path (post-image); for a rename the new path is what the
      // findings should reference.
      currentPath = fileMatch[2];
      currentAdded = [];
      newLine = 0;
      continue;
    }
    if (currentPath === undefined) {
      continue; // preamble before the first file header
    }
    const hunkMatch = raw.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      newLine = Number.parseInt(hunkMatch[1] ?? '0', 10);
      continue;
    }
    if (raw.startsWith('+')) {
      // Skip the `+++ b/…` file header line (handled above only for `diff --git`,
      // but a raw unified diff also carries `+++`/`---` lines).
      if (raw.startsWith('+++')) continue;
      currentAdded.push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      if (raw.startsWith('---')) continue;
      continue; // removed line — does not advance the post-image cursor
    }
    if (raw.startsWith('\\')) {
      continue; // "\ No newline at end of file"
    }
    // Context line (leading space) or other — advances the post-image cursor.
    if (newLine > 0) newLine += 1;
  }
  flush();
  return files;
}

// ─── Handler ──────────────────────────────────────────────────────────────

export async function handleMockBoundary(
  args: MockBoundaryHandlerArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  // Preflight (DR-10): validate the DispatchContext + inputs and resolve the
  // worktree-aware 'auto' repoRoot (#1330). Byte-preserves the prior envelopes.
  const pre = await runGatePreflight(
    {
      featureId: args.featureId,
      taskId: args.taskId,
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      handlerName: 'handleMockBoundary',
      requireTaskId: true,
    },
    eventStore,
  );
  if (!pre.ok) return pre.result;
  const repoRoot = pre.repoRoot;
  const baseRef = args.baseBranch || 'main';

  return runDurableGateProducer(
    {
      gateClass: 'mock-boundary',
      featureId: args.featureId,
      taskId: args.taskId,
      ...(args.branch ? { branch: args.branch } : {}),
      baseRef,
      repoRoot,
      stateDir,
      eventStore,
    },
    async () => {
      const policySkip = resolvePolicySkip({
        gateName: 'check_mock_boundary',
        riskTier: args.riskTier,
        boundaryTouching: args.boundaryTouching,
        config: args.projectConfig,
      });
      if (policySkip) {
        return {
          success: true,
          data: {
            passed: true,
            skipped: true,
            findings: [],
            report: policySkip.reason,
            discriminant: SKIPPED_BY_POLICY,
          },
        };
      }

      const gitExec = args.gitExec ?? defaultGitExec;
      const loadConfig = args.loadConfig ?? loadExarchosConfig;

  // Resolve ownership globs + review-gate severity from `.exarchos.yml`. A
  // missing/invalid config degrades to the schema defaults (firstParty globs)
  // and the built-in advisory default — never a hard failure (INV-4).
      let firstPartyGlobs: readonly string[] = DEFAULT_FIRST_PARTY_GLOBS;
      let resolvedConfig: ResolvedProjectConfig | undefined;
      try {
        const loaded = loadConfig(repoRoot);
        if (loaded?.config.ownership?.firstParty) {
          firstPartyGlobs = loaded.config.ownership.firstParty;
        }
        if (loaded?.config) {
          resolvedConfig = resolveConfig(loaded.config);
        }
      } catch {
        /* malformed config → defaults; the gate never hard-fails on config (INV-4) */
      }

  // Advisory-by-default: DEFAULTS.review.gates['mock-boundary'] resolves to
  // `warning`; a project review-gate override still wins (mirrors tdd-compliance).
      const severity = resolveGateSeverity('mock-boundary', 'D1', resolvedConfig ?? DEFAULTS);

  // Compute the task diff (branch vs merge-base) — the same seam the sibling
  // gates use. `--no-ext-diff` is load-bearing: a user-configured
  // `diff.external` (e.g. a semantic-diff wrapper that summarizes hunks) would
  // otherwise replace the unified diff this parser depends on, silently yielding
  // zero findings. On git failure the diff is empty → zero findings (never a
  // spurious flag).
      const diffResult = gitExec(repoRoot, ['diff', '--no-ext-diff', `${baseRef}...HEAD`]);
      const fileDiffs = diffResult.exitCode === 0 ? parseUnifiedDiff(diffResult.stdout) : [];
      const findings = detectMockFindings(fileDiffs, { firstPartyGlobs });

  // Escape hatch: an explicit, non-empty reason acknowledges an intentional
  // unowned mock and suppresses the verdict (but not the evidence).
      const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
      const escapeHatch = reason.length > 0 ? { acknowledged: true, reason } : undefined;

  // Verdict: pass when there are no unowned findings, OR the escape hatch is
  // acknowledged, OR the gate is advisory (non-blocking). It only fails when the
  // severity is blocking AND an unowned mock is present AND no escape hatch.
      const hasFindings = findings.length > 0;
      const passed = !hasFindings || escapeHatch !== undefined || severity !== 'blocking';

  // Per-finding steers (INV-12) — only when an unowned mock is present and the
  // escape hatch was NOT invoked (acknowledging the mock makes the steer moot).
      const nextActions =
        hasFindings && escapeHatch === undefined ? findings.map(steerForFinding) : [];

  // INV-5b advisory carrier — success:true with data.passed reflecting the
  // verdict, NOT an error envelope.
      return {
        success: true,
        data: {
          passed,
          findings,
          severity,
          ...(escapeHatch ? { escapeHatch } : {}),
          ...(nextActions.length > 0 ? { next_actions: nextActions } : {}),
        },
      };
    },
  );
}

// Re-declare the schema default here so the handler degrades to the SAME
// first-party scope the config schema parse-time default applies, even when no
// `.exarchos.yml` is present. Kept in sync with exarchos-config-schema.ts.
const DEFAULT_FIRST_PARTY_GLOBS: readonly string[] = ['src/**', 'servers/*/src/**'];
