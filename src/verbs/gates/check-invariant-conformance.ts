/**
 * check_invariant_conformance: an `exarchos_orchestrate` action that checks
 * invariant conformance at review.
 *
 * The gate resolves the effective catalog with `resolveEffectiveCatalog`, the
 * same pipeline as the `invariants_effective` view. So it honors the user
 * catalogs and overrides in `.exarchos.yml`. It evaluates each check-mode
 * invariant tree against the diff. It renders each audit-mode invariant into
 * `auditPrompt` and lists the ids in `auditInvariantIds`. The reviewer returns
 * violations as `pluginFindings` on `check_review_verdict`.
 */

import { createHash } from 'node:crypto';

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import type { PluginFinding } from '../../review/check-catalog.js';
import type { ExarchosConfig } from '../../config/exarchos-config-schema.js';
import { loadExarchosConfig } from '../../config/load-exarchos-config.js';
import type { InvariantEntry } from '../../architecture/invariants-loader.js';
import { projectCatalog } from '../../architecture/project-catalog.js';
import {
  resolveEffectiveCatalog,
  type ResolveEffectiveCatalogContext,
  type ResolveEffectiveCatalogResult,
} from '../../architecture/resolve-effective-catalog.js';
import { evaluateTree } from '../../architecture/check-evaluator.js';
import {
  projectAuditPrompt,
  EmptyAuditProjectionError,
  type AuditProjection,
} from '../../architecture/audit-prompt.js';
import { AUDIT_DELIVERY_OBLIGATIONS } from '../../architecture/audit-delivery-closure.data.js';
import {
  computeVerdict,
  generateVerdictReport,
} from '../review/review-verdict.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';
import { requireGateEvent, sameOperationGateKey } from './gate-utils.js';

/**
 * Test seam that supplies the invariant catalog with no disk IO. If a caller
 * injects it, the handler takes the legacy load-and-project path and does not
 * call `resolveEffectiveCatalog`.
 */
export type LoadInvariantsFn = () => InvariantEntry[];

/** Seam for the effective-catalog resolver. The default is the real `resolveEffectiveCatalog`. */
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
  /** Explicit config. Tests use it so that they do not read `.exarchos.yml`. */
  readonly config?: ExarchosConfig;
  /**
   * Legacy test seam that supplies the catalog. If set, the handler takes the
   * legacy load-and-project path and does not call `resolveEffectiveCatalog`.
   */
  readonly loadInvariantsFn?: LoadInvariantsFn;
  /**
   * Legacy test seam for the user-catalog layer. The handler reads it only on
   * the legacy path. On the production path, the user layer comes from
   * `config.invariants.catalogs`, and a malformed user catalog shows in the
   * resolver `warnings`.
   */
  readonly loadUserInvariantsFn?: LoadInvariantsFn;
  /**
   * Seam for the effective-catalog resolver on the production path. The
   * default is `resolveEffectiveCatalog`.
   */
  readonly resolveEffectiveCatalogFn?: ResolveEffectiveCatalogFn;
}

/**
 * The success payload of the gate. It must stay in step with
 * `CheckInvariantConformanceData` in `check-invariant-conformance-schema.ts`,
 * which the registry advertises and the MCP adapter validates.
 */
interface CheckInvariantConformanceResult {
  readonly verdict: 'APPROVED' | 'NEEDS_FIXES' | 'BLOCKED';
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly findings: readonly PluginFinding[];
  /** Audit-mode prompt block for the review subagent. It can be empty. */
  readonly auditPrompt: string;
  /**
   * The invariant ids in {@link auditPrompt}, sorted by id. The review skill
   * tells the reviewer to judge each id and to return violations as
   * `pluginFindings` on `check_review_verdict`.
   */
  readonly auditInvariantIds: readonly string[];
  /**
   * Why {@link auditPrompt} holds what it holds. `no-audit-entries` means that
   * no audit-mode invariant applied. `no-subject` means that the projection
   * resolved nothing, which is a lost subject and not a clean audit.
   */
  readonly auditProjection: 'rendered' | 'no-audit-entries' | 'no-subject';
  /** Size of the projected catalog slice — the audit's denominator. */
  readonly applicableCount: number;
  readonly report: string;
}

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

/**
 * Runs the gate through `runPhaseGateWithEvidence`. The runner records the
 * durable gate evidence before a success result returns, as the other review
 * gates do.
 */
export async function handleCheckInvariantConformance(
  args: CheckInvariantConformanceArgs,
  stateDir: string,
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

  const featureId = args.featureId;
  const diffDigest = createHash('sha256')
    .update(args.diff ?? args.diffContent ?? '', 'utf8')
    .digest('hex');
  return runPhaseGateWithEvidence({
    streamId: featureId,
    gateClass: 'invariant-conformance',
    requirementId: 'requirement:invariant-conformance',
    stateDir,
    eventStore,
    subject: (phaseAttemptId) =>
      createEvidenceSubject(
        { kind: 'phase-attempt', phaseAttemptId },
        {
          gate: 'invariant-conformance',
          workflowType: args.workflowType ?? null,
          phase: args.phase ?? null,
          diffDigest,
        },
      ),
    providerInput: args,
    executeProvider: async () => executeCheckInvariantConformance(args, eventStore),
  });
}

/**
 * Evaluates the invariants for one gate run.
 *
 * Without `args.config` or `loadInvariantsFn`, it loads `.exarchos.yml` from
 * `repoRoot` or the cwd, because the action schema carries no `config`. A
 * config load error, a resolver warning, a check tree that throws, and an
 * empty catalog slice each add a `LOW` finding. They do not stop the gate.
 * An empty slice gives `auditProjection: 'no-subject'`, so it cannot read as a
 * clean audit. Each check-mode finding takes the severity that its invariant
 * resolves for the context. If `invariants.enforcement.review` is `advisory`,
 * the verdict uses zero counts, but the result keeps the real counts.
 */
async function executeCheckInvariantConformance(
  args: CheckInvariantConformanceArgs,
  eventStore: EventStore,
): Promise<ToolResult> {
  const workflowType = args.workflowType ?? 'feature';
  const phase = args.phase ?? 'review';
  const diff = args.diff ?? args.diffContent ?? '';

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
    for (const warning of warnings) {
      findings.push({
        source: 'effective-catalog',
        severity: 'LOW',
        message: warning,
      });
    }
  }

  for (const entry of applicable) {
    if (entry.enforcement?.mode !== 'check') continue;

    let treeFindings: PluginFinding[];
    try {
      treeFindings = evaluateTree(entry.enforcement.check, diff, phase);
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

  let projection: AuditProjection | undefined;
  try {
    projection = projectAuditPrompt(applicable);
  } catch (err) {
    if (!(err instanceof EmptyAuditProjectionError)) throw err;
    findings.push({
      source: 'invariant-audit',
      severity: 'LOW',
      message:
        `No invariant was audited: ${err.message} Reported rather than rendered ` +
        `as an empty prompt.`,
    });
  }

  const auditPrompt = projection?.prompt ?? '';
  const auditInvariantIds = projection?.invariantIds ?? [];
  const auditProjection = projection?.status ?? 'no-subject';

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

  const enforcementReview =
    effectiveConfig?.invariants?.enforcement?.review ?? 'blocking';
  const verdict =
    enforcementReview === 'advisory'
      ? computeVerdict({ high: 0, medium: 0, low: 0 })
      : computeVerdict(counts);
  const report =
    generateVerdictReport(verdict, counts) +
    renderAuditDirective(auditInvariantIds);

  const result: CheckInvariantConformanceResult = {
    verdict,
    high,
    medium,
    low,
    findings,
    auditPrompt,
    auditInvariantIds,
    auditProjection,
    applicableCount: applicable.length,
    report,
  };
  const carrier: ToolResult = { success: true, data: result };

  const unrecorded = await requireGateEvent(
    eventStore,
    args.featureId,
    'invariant-conformance',
    'review',
    verdict === 'APPROVED',
    carrier,
    {
      verdict,
      phase,
      workflowType,
      high,
      medium,
      low,
      applicableCount: applicable.length,
      auditProjection,
      auditInvariantCount: auditInvariantIds.length,
    },
    sameOperationGateKey('invariant-conformance'),
  );
  if (unrecorded !== undefined) return unrecorded;

  return carrier;
}

/**
 * Appends the audit-mode obligation to `report`. The text comes from
 * `AUDIT_DELIVERY_OBLIGATIONS`, the same record that `audit-delivery-closure.ts`
 * checks the review skill against, so the directive and the skill step agree.
 * The directive does not replace the skill step. It carries the obligation to
 * a consumer that calls the action without the skill.
 */
function renderAuditDirective(auditInvariantIds: readonly string[]): string {
  if (auditInvariantIds.length === 0) return '';
  const obligation = AUDIT_DELIVERY_OBLIGATIONS.find(
    (o) => o.declarationId === 'exarchos_orchestrate.check_invariant_conformance',
  );
  if (obligation === undefined) return '';
  return (
    `\n\n${auditInvariantIds.length} audit-mode invariant(s) require reviewer ` +
    `judgment and are NOT decided by this gate: ${auditInvariantIds.join(', ')}. ` +
    `Read \`${obligation.field}\`, then ${obligation.expectation}. ` +
    `An unanswered audit-mode invariant is not a pass.`
  );
}
