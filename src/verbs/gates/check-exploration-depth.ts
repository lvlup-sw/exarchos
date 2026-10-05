/**
 * The `check_exploration_depth` gate. A `deep` spec must have the `### Exploration` section of
 * the spec template, and the section must cite a `/exarchos:discover` report path and a
 * `correlationId`. Otherwise the gate returns `data.passed: false`.
 * At any other `designDepth` stamp, the gate records a skip and does not read the spec.
 */

import { readFile } from 'node:fs/promises';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import type { DesignDepth } from '../../workflow/plan-depth-policy.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';
import { requireGateEvent, sameOperationGateKey } from './gate-utils.js';
import { resolveWorkflowState } from '../resolve-state.js';

/** Discriminant carried by a gate skipped because the spec is not `deep` depth. */
export const SKIPPED_BY_DEPTH = 'skipped-by-depth';

/** The exact h3 header the deep-depth template requires. */
const EXPLORATION_HEADER = /^###\s+Exploration\b/i;

/**
 * A path-like citation with at least one slash and a file extension. It matches a bare path,
 * a backticked path, or a markdown link target, for example `[report](docs/research/foo.md)`.
 */
const PATH_CITATION = /[\w.-]+\/[\w./-]*\.[a-z0-9]+/i;

/** A `correlationId` citation: the `correlationId` word, or a `discover-bridge:<featureId>` value. */
const CORRELATION_ID_CITATION = /correlation[\s_-]?id|discover-bridge:/i;

/**
 * Returns the lines under the `### Exploration` header, up to the next h1, h2, or h3 heading.
 * An h4 subsection stays in the body. Returns `null` when the header is absent.
 */
export function extractExplorationSection(markdown: string): string | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => EXPLORATION_HEADER.test(line));
  if (start === -1) return null;

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const bodyLine = lines[i] ?? '';
    if (/^#{1,3}\s+/.test(bodyLine)) break;
    body.push(bodyLine);
  }
  return body.join('\n');
}

/** Verdict from {@link checkExplorationDepth}. */
export interface ExplorationCheckResult {
  readonly passed: boolean;
  readonly hasSection: boolean;
  readonly citesPath: boolean;
  readonly citesCorrelationId: boolean;
  readonly reason: string;
}

/**
 * Pure check of a `deep` spec. It fails when the `### Exploration` section is absent, or when
 * the section does not cite both a report path and a `correlationId`.
 */
export function checkExplorationDepth(markdown: string): ExplorationCheckResult {
  const section = extractExplorationSection(markdown);
  if (section === null) {
    return {
      passed: false,
      hasSection: false,
      citesPath: false,
      citesCorrelationId: false,
      reason:
        "deep-depth spec is missing the required '### Exploration' section " +
        '(deep specs must cite the /exarchos:discover research pass by path + correlationId).',
    };
  }

  const citesPath = PATH_CITATION.test(section);
  const citesCorrelationId = CORRELATION_ID_CITATION.test(section);
  const passed = citesPath && citesCorrelationId;

  let reason: string;
  if (passed) {
    reason = "'### Exploration' section cites the /exarchos:discover pass by path + correlationId.";
  } else {
    const missing: string[] = [];
    if (!citesPath) missing.push('a /exarchos:discover report path');
    if (!citesCorrelationId) missing.push('a correlationId');
    reason =
      "'### Exploration' section is present but does not cite " +
      `${missing.join(' and ')} (deep specs must stitch the discover pass by path + correlationId).`;
  }

  return { passed, hasSection: true, citesPath, citesCorrelationId, reason };
}

/**
 * Returns a skip reason for each `designDepth` other than `deep`, an absent stamp included.
 * Returns `null` at `deep`. The shape matches `resolvePolicySkip`.
 */
export function resolveExplorationSkip(
  designDepth: DesignDepth | undefined,
): { readonly reason: string } | null {
  if (designDepth === 'deep') return null;
  return {
    reason:
      `skipped — the '### Exploration' citation is a deep-depth obligation; ` +
      `designDepth=${designDepth ?? '<unset>'} is not 'deep'.`,
  };
}

interface CheckExplorationDepthArgs {
  readonly featureId: string;
  /** Path to the unified spec. Resolved from state when absent. */
  readonly designPath?: string;
  /** Frozen `designDepth` stamp. Resolved from `state.designDepth` when absent. */
  readonly designDepth?: DesignDepth;
  /** Optional explicit `.state.json` path (legacy / no-event-store callers). */
  readonly stateFile?: string;
}

/**
 * Takes `designDepth` and the spec path from the arguments, then from workflow state.
 * The path comes from `artifacts.plan`, then `artifacts.design`. A state resolution miss is not
 * fatal: the arguments stand, and the deep path refuses an unresolved path with `INVALID_INPUT`.
 */
async function resolveDepthAndPath(
  args: CheckExplorationDepthArgs,
  eventStore: EventStore,
): Promise<{ designDepth?: DesignDepth | undefined; designPath?: string | undefined }> {
  let designDepth = args.designDepth;
  let designPath = args.designPath;

  if (designDepth !== undefined && designPath !== undefined) {
    return { designDepth, designPath };
  }

  const resolved = await resolveWorkflowState({
    featureId: args.featureId,
    eventStore,
    ...(args.stateFile ? { stateFile: args.stateFile } : {}),
  });
  if ('error' in resolved) {
    return { designDepth, designPath };
  }

  const state = resolved.state;
  if (designDepth === undefined && typeof state.designDepth === 'string') {
    designDepth = state.designDepth as DesignDepth;
  }
  if (designPath === undefined) {
    const artifacts = state.artifacts;
    if (artifacts && typeof artifacts === 'object' && !Array.isArray(artifacts)) {
      const rec = artifacts as Record<string, unknown>;
      const candidate = rec.plan ?? rec.design;
      if (typeof candidate === 'string' && candidate.length > 0) {
        designPath = candidate;
      }
    }
  }

  return { designDepth, designPath };
}

/**
 * The `check_exploration_depth` gate handler. It runs through the shared phase-gate runner,
 * which records durable gate evidence before a success carrier returns. The provider records
 * a gate event for gate `exploration-depth`, layer `planning`, on the skip and verdict paths.
 */
export async function handleCheckExplorationDepth(
  args: CheckExplorationDepthArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!eventStore) {
    return {
      success: false,
      error: { code: 'MISWIRED_CONTEXT', message: 'handleCheckExplorationDepth: eventStore is required' },
    };
  }
  if (!args.featureId) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'featureId is required' } };
  }

  return runPhaseGateWithEvidence({
    streamId: args.featureId,
    gateClass: 'exploration-depth',
    requirementId: 'requirement:exploration-depth',
    stateDir,
    eventStore,
    subject: (phaseAttemptId) =>
      createEvidenceSubject(
        { kind: 'phase-attempt', phaseAttemptId },
        { gate: 'exploration-depth', phase: 'plan' },
      ),
    providerInput: args,
    executeProvider: async () => executeCheckExplorationDepth(args, eventStore),
  });
}

/** Records a skip below `deep` depth. At `deep`, reads the spec and records the verdict. */
async function executeCheckExplorationDepth(
  args: CheckExplorationDepthArgs,
  eventStore: EventStore,
): Promise<ToolResult> {
  const { designDepth, designPath } = await resolveDepthAndPath(args, eventStore);

  const skip = resolveExplorationSkip(designDepth);
  if (skip) {
    const carrier: ToolResult = {
      success: true,
      data: {
        passed: true,
        skipped: true,
        discriminant: SKIPPED_BY_DEPTH,
        designDepth: designDepth ?? null,
        reason: skip.reason,
      },
    };
    const unrecorded = await requireGateEvent(
      eventStore,
      args.featureId,
      'exploration-depth',
      'planning',
      true,
      carrier,
      {
        dimension: 'D1',
        phase: 'plan',
        designDepth: designDepth ?? null,
        skipped: true,
        discriminant: SKIPPED_BY_DEPTH,
        reason: skip.reason,
      },
      sameOperationGateKey('exploration-depth'),
    );
    if (unrecorded !== undefined) return unrecorded;
    return carrier;
  }

  if (!designPath) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          'designPath could not be resolved — pass designPath, or record artifacts.plan/design in workflow state.',
      },
    };
  }

  let content: string;
  try {
    content = await readFile(designPath, 'utf-8');
  } catch (err) {
    return {
      success: false,
      error: { code: 'FILE_ERROR', message: err instanceof Error ? err.message : String(err) },
    };
  }

  const result = checkExplorationDepth(content);

  const carrier: ToolResult = {
    success: true,
    data: {
      passed: result.passed,
      skipped: false,
      designDepth: 'deep',
      hasSection: result.hasSection,
      citesPath: result.citesPath,
      citesCorrelationId: result.citesCorrelationId,
      reason: result.reason,
    },
  };

  const unrecorded = await requireGateEvent(
    eventStore,
    args.featureId,
    'exploration-depth',
    'planning',
    result.passed,
    carrier,
    {
      dimension: 'D1',
      phase: 'plan',
      designDepth: 'deep',
      hasSection: result.hasSection,
      citesPath: result.citesPath,
      citesCorrelationId: result.citesCorrelationId,
    },
    sameOperationGateKey('exploration-depth'),
  );
  if (unrecorded !== undefined) return unrecorded;

  return carrier;
}
