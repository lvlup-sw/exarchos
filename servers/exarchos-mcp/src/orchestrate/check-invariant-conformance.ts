// ─── check_invariant_conformance Orchestrate Handler (DR-3, DR-4) ───────────
//
// Invariant conformance as a review dimension. At phase=review the gate:
//   1. resolves the effective catalog for (workflow-type, phase:'review',
//      touched-files) via resolveEffectiveCatalog (DR-6/DR-7) — the SAME
//      pipeline the `invariants_effective` view uses: it reads
//      config.invariants.catalogs (user catalogs), runs mergeCatalogs +
//      applyOverrides (per-invariant override floor), drops honored-disabled
//      entries, then projects. The gate therefore honors a consumer's
//      `.exarchos.yml` overrides and catalogs; its DR-9 malformed-user-catalog
//      degradation is reachable in production (warnings folded into findings),
//      not just under a DI double;
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

import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import type { PluginFinding } from '../review/check-catalog.js';
import type { ExarchosConfig } from '../config/exarchos-config-schema.js';
import { loadExarchosConfig } from '../config/load-exarchos-config.js';
import type { InvariantEntry } from '../architecture/invariants-loader.js';
import { projectCatalog } from '../architecture/project-catalog.js';
import {
  resolveEffectiveCatalog,
  type ResolveEffectiveCatalogContext,
  type ResolveEffectiveCatalogResult,
} from '../architecture/resolve-effective-catalog.js';
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
 *
 * NOTE: this is a LEGACY seam retained for the parity test and a few unit
 * tests that inject a deterministic catalog. The DEFAULT production path no
 * longer uses it — it resolves the catalog via `resolveEffectiveCatalog`
 * (see `resolveEffectiveCatalogFn`). When `loadInvariantsFn` is injected the
 * handler takes the legacy load→project path instead, so those tests keep
 * exercising the same shape without disk IO.
 */
export type LoadInvariantsFn = () => InvariantEntry[];

/**
 * DI seam for the effective-catalog resolver. Defaults to the real
 * `resolveEffectiveCatalog` so the DEFAULT (no-loader) path exercises
 * production behaviour: user `catalogs`, `overrides`, the honored-disable
 * filter, and DR-9 degradation warnings all flow through. Tests can override
 * it, but the override-applied and user-catalog-degradation paths are proven
 * through CONFIG (not this seam) per the fix requirements.
 */
export type ResolveEffectiveCatalogFn = (
  ctx: ResolveEffectiveCatalogContext,
) => ResolveEffectiveCatalogResult;

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
  /**
   * LEGACY DI seam: supply the catalog directly (parity test / a few unit
   * tests). When present the handler takes the legacy load→project path and
   * does NOT consult `resolveEffectiveCatalog`. Absent ⇒ the production path
   * runs (`resolveEffectiveCatalogFn`).
   */
  readonly loadInvariantsFn?: LoadInvariantsFn;
  /**
   * LEGACY DI seam for the USER-catalog layer (DR-9). Only consulted on the
   * legacy path (when `loadInvariantsFn` is also injected). On the production
   * path the user layer comes from `config.invariants.catalogs` via
   * `resolveEffectiveCatalog`, and DR-9 degradation surfaces through that
   * function's `warnings`.
   */
  readonly loadUserInvariantsFn?: LoadInvariantsFn;
  /**
   * DI seam for the effective-catalog resolver. Defaults to the real
   * `resolveEffectiveCatalog`; the production (no-`loadInvariantsFn`) path
   * uses it so consumer `overrides`/`catalogs` and DR-9 degradation are
   * exercised for real.
   */
  readonly resolveEffectiveCatalogFn?: ResolveEffectiveCatalogFn;
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

  // Resolve the EFFECTIVE config the gate runs against. Precedence:
  //   1. an explicit `args.config` (DI for tests / callers that already
  //      loaded `.exarchos.yml`);
  //   2. otherwise load `.exarchos.yml` from `args.repoRoot` (or cwd) — the
  //      SAME source the `invariants_effective` view reads. This is what closes
  //      the production gap: the registry action schema does not carry `config`,
  //      so without this load a consumer's `.exarchos.yml` overrides/catalogs
  //      would never reach the gate. A config read failure (bad YAML) degrades
  //      to "no config" (default-disabled) and surfaces a LOW advisory rather
  //      than aborting the gate (INV-1).
  const findings: PluginFinding[] = [];
  let effectiveConfig: ExarchosConfig | undefined = args.config;
  if (effectiveConfig === undefined && args.loadInvariantsFn === undefined) {
    try {
      const loaded = loadExarchosConfig(args.repoRoot ?? process.cwd());
      effectiveConfig = loaded?.config;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      findings.push({
        source: 'exarchos-config-load',
        severity: 'LOW',
        message:
          `.exarchos.yml failed to load and was skipped; the invariant gate ` +
          `ran with default (no-config) settings. Reason: ${reason}`,
      });
    }
  }

  // 1. Resolve the effective catalog for the (workflow-type, phase,
  //    touched-files) context.
  //
  // PRODUCTION PATH (DR-6/DR-7): resolveEffectiveCatalog reads
  // config.invariants.catalogs (user catalogs), runs mergeCatalogs +
  // applyOverrides (per-invariant override floor), drops honored-disabled
  // entries, then projects. Its `warnings` carry DR-9 degradation (a malformed
  // user catalog is skipped, not fatal) plus any override-clamp notes; we fold
  // them into the findings as LOW advisories so they surface in the REAL path.
  //
  // LEGACY PATH: when a test injects `loadInvariantsFn`, take the old
  // load→project route (shipped + optional user double) so the parity test and
  // catalog-shape unit tests keep working without disk IO. The malformed-user
  // double (`loadUserInvariantsFn`) is only consulted here.
  let applicable: InvariantEntry[];
  if (args.loadInvariantsFn) {
    const shipped = args.loadInvariantsFn();
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
    applicable = projectCatalog([...shipped, ...userLayer], {
      phase,
      workflowType,
      ...(args.touchedFiles ? { touchedFiles: [...args.touchedFiles] } : {}),
    });
  } else {
    const resolve = args.resolveEffectiveCatalogFn ?? resolveEffectiveCatalog;
    const { entries, warnings } = resolve({
      ...(args.repoRoot !== undefined ? { repoRoot: args.repoRoot } : {}),
      ...(effectiveConfig !== undefined ? { config: effectiveConfig } : {}),
      phase,
      workflowType,
      ...(args.touchedFiles ? { touchedFiles: [...args.touchedFiles] } : {}),
    });
    applicable = entries;
    // DR-9 end-to-end: fold resolver warnings (malformed user catalog skipped,
    // override-clamp notes) into the gate's findings as LOW advisories — never
    // silently swallowed (INV-1), never gating.
    for (const warning of warnings) {
      findings.push({
        source: 'effective-catalog',
        severity: 'LOW',
        message: warning,
      });
    }
  }

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

  // FIX-2: honor config.invariants.enforcement.review.
  //   - 'blocking' (or absent — the pre-T-18 default, which gated normally):
  //     findings drive the verdict; a HIGH ⇒ NEEDS_FIXES.
  //   - 'advisory': invariant-conformance findings are surfaced but must NOT
  //     gate. We compute the verdict with the severity counts zeroed so the
  //     verdict stays APPROVED, while the REAL counts/findings are preserved in
  //     the result for transparency.
  const enforcementReview =
    effectiveConfig?.invariants?.enforcement?.review ?? 'blocking';
  const verdict =
    enforcementReview === 'advisory'
      ? computeVerdict({ high: 0, medium: 0, low: 0 })
      : computeVerdict(counts);
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
