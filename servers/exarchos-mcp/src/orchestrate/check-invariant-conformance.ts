// ─── check_invariant_conformance Orchestrate Handler (DR-3, DR-4) ───────────
//
// Invariant conformance as a review dimension. At phase=review the gate:
//   1. resolves the effective catalog for (workflow-type, phase:'review',
//      touched-files) via projectCatalog over the loaded+merged catalog;
//   2. evaluates every `enforcement.mode === 'check'` invariant's combinator
//      tree against the diff (deterministic) → findings;
//   3. renders every applicable `mode:'audit'` invariant into a prompt via
//      renderAuditPrompt → the review subagent's answers re-enter as
//      pluginFindings;
//   4. folds both into the check_review_verdict severity-merge path using each
//      invariant's context-resolved `severity`.
//
// Stays within the 4 visible composite tools (INV-5d) — this is a new ACTION on
// `exarchos_orchestrate`, NOT a new tool. Same DispatchContext+args ⇒ identical
// ToolResult on CLI and MCP (INV-2).
// ────────────────────────────────────────────────────────────────────────────

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import type { PluginFinding } from '../review/check-catalog.js';
import type { ExarchosConfig } from '../config/exarchos-config-schema.js';
import {
  loadInvariants,
  type InvariantEntry,
} from '../architecture/invariants-loader.js';
import { projectCatalog } from '../architecture/project-catalog.js';
import { evaluateTree } from '../architecture/check-evaluator.js';
import { renderAuditPrompt } from '../architecture/audit-prompt.js';
import {
  computeVerdict,
  generateVerdictReport,
} from './review-verdict.js';
import { emitGateEvent } from './gate-utils.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Dependency-injection seam for loading the invariant catalog. The default
 * reads `docs/architecture/invariants.md` (honouring the devCatalog gate);
 * tests inject an explicit `InvariantEntry[]` so they need no disk IO.
 */
export type LoadInvariantsFn = () => InvariantEntry[];

export interface CheckInvariantConformanceArgs {
  readonly featureId: string;
  /** Workflow kind (default `'feature'`). Drives projection + severity. */
  readonly workflowType?: string;
  /** SDLC phase the gate runs in (default `'review'`). */
  readonly phase?: string;
  /** Files the current change touches (delegate-phase projection input). */
  readonly touchedFiles?: readonly string[];
  /** Unified diff to evaluate check-mode trees against. */
  readonly diff?: string;
  /** Alias for `diff` (mirrors other gate handlers' naming). */
  readonly diffContent?: string;
  /** Repository root — used to locate the catalog when no loader is injected. */
  readonly repoRoot?: string;
  /** Explicit config (DI for tests so they don't read `.exarchos.yml`). */
  readonly config?: ExarchosConfig;
  /** DI seam: supply the catalog directly (tests / non-disk callers). */
  readonly loadInvariantsFn?: LoadInvariantsFn;
  /**
   * DI seam for the USER-catalog layer (DR-9). Kept separate from
   * `loadInvariantsFn` (the shipped layers) so a malformed user catalog can be
   * caught and degraded independently: on failure the gate continues with the
   * shipped layers and surfaces an advisory finding rather than aborting.
   * The default handler has no user-catalog loader wired yet; tests inject one.
   */
  readonly loadUserInvariantsFn?: LoadInvariantsFn;
}

interface CheckInvariantConformanceResult {
  readonly verdict: 'APPROVED' | 'NEEDS_FIXES' | 'BLOCKED';
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly findings: readonly PluginFinding[];
  /** Audit-mode prompt block for the review subagent (DR-4). May be empty. */
  readonly auditPrompt: string;
  readonly report: string;
}

// ─── Severity Resolution (DR-3) ──────────────────────────────────────────────

/**
 * Resolve an invariant's effective severity for the gate context. Precedence:
 * `by-phase` > `by-workflow` > `default`. An entry with no `severity` block
 * defaults to `advisory`.
 */
function resolveSeverity(
  entry: InvariantEntry,
  workflowType: string,
  phase: string,
): 'blocking' | 'advisory' {
  const sev = entry.severity;
  if (sev === undefined) return 'advisory';
  const byPhase = sev['by-phase']?.[phase];
  if (byPhase !== undefined) return byPhase;
  const byWorkflow = sev['by-workflow']?.[workflowType];
  if (byWorkflow !== undefined) return byWorkflow;
  return sev.default;
}

/** Map context-resolved invariant severity to a PluginFinding severity. */
function toFindingSeverity(severity: 'blocking' | 'advisory'): PluginFinding['severity'] {
  return severity === 'blocking' ? 'HIGH' : 'MEDIUM';
}

// ─── Default Catalog Loader ──────────────────────────────────────────────────

/**
 * Resolve the repository root from this module's location:
 * `src/orchestrate/check-invariant-conformance.ts` → repo root is four levels up.
 */
function moduleRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../..');
}

function defaultLoadInvariants(args: CheckInvariantConformanceArgs): InvariantEntry[] {
  const root = args.repoRoot ?? moduleRepoRoot();
  const docPath = path.join(root, 'docs/architecture/invariants.md');
  return loadInvariants(docPath, { scope: 'all' }, args.config);
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleCheckInvariantConformance(
  args: CheckInvariantConformanceArgs,
  _stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!eventStore) {
    return {
      success: false,
      error: {
        code: 'MISWIRED_CONTEXT',
        message: 'handleCheckInvariantConformance: eventStore is required',
      },
    };
  }

  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  const workflowType = args.workflowType ?? 'feature';
  const phase = args.phase ?? 'review';
  const diff = args.diff ?? args.diffContent ?? '';

  // Accumulates findings produced while degrading gracefully (DR-9). Seeded
  // here so a user-catalog load failure can append an advisory before the
  // check-mode evaluation loop runs.
  const findings: PluginFinding[] = [];

  // 1. Load → (merge happens upstream in the loader's layering) → project for
  //    the (workflow-type, phase, touched-files) context.
  //
  // DR-9 §1: load the SHIPPED layers first, then attempt the USER catalog in a
  // try/catch. A malformed user catalog (bad YAML / unknown check kind /
  // reserved-namespace id) must DEGRADE to the shipped layers and surface a
  // non-fatal advisory finding naming the failed catalog — never silently
  // swallowed (INV-1), never aborting the whole gate.
  const shipped = args.loadInvariantsFn
    ? args.loadInvariantsFn()
    : defaultLoadInvariants(args);

  let userLayer: InvariantEntry[] = [];
  if (args.loadUserInvariantsFn) {
    try {
      userLayer = args.loadUserInvariantsFn();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      findings.push({
        source: 'user-catalog-load',
        severity: 'LOW',
        message:
          `User invariant catalog failed to load and was skipped; ` +
          `evaluated shipped layers only. Reason: ${reason}`,
      });
    }
  }

  const loaded = [...shipped, ...userLayer];

  const applicable = projectCatalog(loaded, {
    phase,
    workflowType,
    ...(args.touchedFiles ? { touchedFiles: [...args.touchedFiles] } : {}),
  });

  // 2. Evaluate every check-mode invariant's combinator tree against the diff.
  // 3. Render every applicable audit-mode invariant into a prompt block.
  for (const entry of applicable) {
    if (entry.enforcement?.mode !== 'check') continue;

    // DR-9 §2: a single leaf/tree throwing during evaluation (e.g. an invalid
    // regex) must be captured as a LOW finding naming the invariant id — never
    // propagated to abort the whole gate.
    let treeFindings: PluginFinding[];
    try {
      treeFindings = evaluateTree(entry.enforcement.check, diff);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      findings.push({
        source: `invariant:${entry.id}`,
        severity: 'LOW',
        dimension: entry.id,
        message:
          `Invariant '${entry.id}' check evaluation threw and was skipped; ` +
          `treated as non-blocking. Reason: ${reason}`,
      });
      continue;
    }

    if (treeFindings.length === 0) continue;
    // Re-key each evaluator finding to the invariant's context-resolved
    // severity (default / by-workflow / by-phase) so the severity-merge path
    // counts it correctly. The evaluator emits MEDIUM placeholders; the
    // catalog severity is the authority.
    const findingSeverity = toFindingSeverity(
      resolveSeverity(entry, workflowType, phase),
    );
    for (const f of treeFindings) {
      findings.push({
        ...f,
        source: `invariant:${entry.id}`,
        severity: findingSeverity,
        dimension: entry.id,
      });
    }
  }

  const auditPrompt = renderAuditPrompt(applicable);

  // 4. Fold both the evaluator findings and any audit findings the subagent
  //    re-enters into the check_review_verdict severity-merge path. We reuse
  //    its severity-counting verbatim so a blocking-severity violation ⇒
  //    NEEDS_FIXES (or BLOCKED when a blockedReason is supplied upstream).
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const finding of findings) {
    switch (finding.severity) {
      case 'HIGH': high++; break;
      case 'MEDIUM': medium++; break;
      case 'LOW': low++; break;
    }
  }

  const counts = { high, medium, low };
  const verdict = computeVerdict(counts);
  const report = generateVerdictReport(verdict, counts);

  // STILL emit gate.executed even when the applicable catalog is empty
  // (fire-and-forget: emission failure must not break the gate check).
  try {
    await emitGateEvent(
      eventStore,
      args.featureId,
      'invariant-conformance',
      'review',
      verdict === 'APPROVED',
      {
        verdict,
        phase,
        workflowType,
        high,
        medium,
        low,
        applicableCount: applicable.length,
      },
    );
  } catch { /* fire-and-forget */ }

  const result: CheckInvariantConformanceResult = {
    verdict,
    high,
    medium,
    low,
    findings,
    auditPrompt,
    report,
  };

  return { success: true, data: result };
}
