import type { WorkflowEvent } from '../event-store/schemas.js';
import type { EvalCase } from './types.js';
import { captureTrace } from './trace-capture.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TriageResult {
  readonly regressionCandidates: EvalCase[];
  readonly capabilityCandidates: EvalCase[];
  readonly discarded: number;
}

export interface TriageOptions {
  readonly skill?: string;
  readonly deduplicationThreshold?: number;
}

// ─── Event Classification Constants ─────────────────────────────────────────

/** Events indicating the workflow reached a terminal (completed) state. */
const COMPLETION_EVENT_TYPES = new Set([
  'workflow.cleanup',
  'workflow.cancel',
]);

/** Events indicating retries or self-correction within a workflow. */
const RETRY_EVENT_TYPES = new Set([
  'task.failed',
  'workflow.fix-cycle',
  'workflow.cas-failed',
  'workflow.guard-failed',
  'tool.errored',
]);

/** Events indicating novel tool usage patterns. */
const TOOL_EVENT_TYPES = new Set([
  'tool.invoked',
  'tool.completed',
  'tool.errored',
]);

// ─── Predicates ─────────────────────────────────────────────────────────────

/** Returns true if the trace is too short to be meaningful (< 3 events). */
function isTriviallyShort(events: WorkflowEvent[]): boolean {
  return events.length < 3;
}

/** Returns true if the trace contains a terminal completion event. */
function isWorkflowComplete(events: WorkflowEvent[]): boolean {
  return events.some((e) => COMPLETION_EVENT_TYPES.has(e.type));
}

/** Returns true if the trace contains retry or self-correction patterns. */
function hasRetryPatterns(events: WorkflowEvent[]): boolean {
  return events.some((e) => RETRY_EVENT_TYPES.has(e.type));
}

/** Returns true if all gate.executed events in the trace passed. */
function allGatesPassed(events: WorkflowEvent[]): boolean {
  const gateEvents = events.filter((e) => e.type === 'gate.executed');
  if (gateEvents.length === 0) return true;
  return gateEvents.every((e) => (e.data as Record<string, unknown>)?.passed === true);
}

/** Returns true if the trace contains tool invocation events. */
function hasToolEvents(events: WorkflowEvent[]): boolean {
  return events.some((e) => TOOL_EVENT_TYPES.has(e.type));
}

/**
 * Compute a structural similarity score between two input records.
 *
 * Compares the set of top-level keys and the string-coerced values. Returns
 * a value between 0 (completely different) and 1 (identical structure and values).
 */
function structuralSimilarity(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);

  if (keysA.length === 0 && keysB.length === 0) return 1;

  const allKeys = new Set([...keysA, ...keysB]);
  let matches = 0;

  for (const key of allKeys) {
    if (key in a && key in b) {
      if (String(a[key]) === String(b[key])) {
        matches += 1;
      } else {
        matches += 0.5; // same key, different value
      }
    }
    // key in only one object: 0 contribution
  }

  return matches / allKeys.size;
}

/**
 * Check if any captured eval case is a near-duplicate of existing dataset cases.
 */
function isDuplicate(
  captured: EvalCase,
  existingCases: EvalCase[],
  threshold: number,
): boolean {
  for (const existing of existingCases) {
    const inputSim = structuralSimilarity(captured.input, existing.input);
    const expectedSim = structuralSimilarity(captured.expected, existing.expected);
    const avgSim = (inputSim + expectedSim) / 2;

    if (avgSim >= threshold) return true;
  }

  return false;
}

// ─── Core Triage Logic ──────────────────────────────────────────────────────

/**
 * Classify workflow trace events into regression candidates, capability
 * candidates, and discarded traces.
 *
 * Triage rules:
 * 1. Empty input or trivially short traces (< 3 events) → discard
 * 2. Incomplete workflows (no completion event) → discard
 * 3. Duplicates of existing dataset cases → discard
 * 4. Completed workflows with retries/self-corrections or novel tool patterns → capability
 * 5. Completed clean workflows with all gates passed → regression
 */
export function triageTrace(
  traceEvents: WorkflowEvent[],
  existingDatasets: Map<string, EvalCase[]>,
  options: TriageOptions,
): TriageResult {
  const empty: TriageResult = {
    regressionCandidates: [],
    capabilityCandidates: [],
    discarded: 0,
  };

  // Guard: empty input
  if (traceEvents.length === 0) return empty;

  // Rule 1: trivially short traces
  if (isTriviallyShort(traceEvents)) {
    return { ...empty, discarded: 1 };
  }

  // Rule 2: incomplete workflows
  if (!isWorkflowComplete(traceEvents)) {
    return { ...empty, discarded: 1 };
  }

  // Capture eval cases from the trace
  const captured = captureTrace(traceEvents, { skill: options.skill });

  if (captured.length === 0) {
    return { ...empty, discarded: 1 };
  }

  // Rule 3: deduplication against existing datasets
  const threshold = options.deduplicationThreshold ?? 0.9;
  const relevantExisting = resolveExistingCases(existingDatasets, options.skill);

  if (relevantExisting.length > 0) {
    const allDuplicates = captured.every((c) =>
      isDuplicate(c, relevantExisting, threshold),
    );
    if (allDuplicates) {
      return { ...empty, discarded: 1 };
    }
  }

  // Rule 4: retries or novel patterns → capability
  const hasRetries = hasRetryPatterns(traceEvents);
  const hasNovel = hasToolEvents(traceEvents);

  if (hasRetries || hasNovel) {
    const capabilityCases = captured.map((c) => ({
      ...c,
      layer: 'capability' as const,
      tags: [...c.tags.filter((t) => t !== 'captured'), 'auto-triaged', 'capability'],
    }));

    return {
      regressionCandidates: [],
      capabilityCandidates: capabilityCases,
      discarded: 0,
    };
  }

  // Rule 5: clean completed workflow with all gates passed → regression
  if (allGatesPassed(traceEvents)) {
    const regressionCases = captured.map((c) => ({
      ...c,
      layer: 'regression' as const,
      tags: [...c.tags.filter((t) => t !== 'captured'), 'auto-triaged', 'regression'],
    }));

    return {
      regressionCandidates: regressionCases,
      capabilityCandidates: [],
      discarded: 0,
    };
  }

  // Fallback: completed but gates failed — capability
  const fallbackCases = captured.map((c) => ({
    ...c,
    layer: 'capability' as const,
    tags: [...c.tags.filter((t) => t !== 'captured'), 'auto-triaged', 'capability'],
  }));

  return {
    regressionCandidates: [],
    capabilityCandidates: fallbackCases,
    discarded: 0,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve existing eval cases relevant for deduplication. If a skill is
 * specified, only return cases from that dataset; otherwise merge all.
 */
function resolveExistingCases(
  datasets: Map<string, EvalCase[]>,
  skill?: string,
): EvalCase[] {
  if (skill) {
    return datasets.get(skill) ?? [];
  }

  const all: EvalCase[] = [];
  for (const cases of datasets.values()) {
    all.push(...cases);
  }
  return all;
}
