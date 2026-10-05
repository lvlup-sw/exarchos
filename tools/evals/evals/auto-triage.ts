import type { WorkflowEvent } from '../../../src/events/schemas.js';
import type { EvalCase } from './types.js';
import { captureTrace } from './trace-capture.js';

export interface TriageResult {
  readonly regressionCandidates: EvalCase[];
  readonly capabilityCandidates: EvalCase[];
  readonly discarded: number;
}

export interface TriageOptions {
  readonly skill?: string;
  readonly deduplicationThreshold?: number;
}

/** Events that show the workflow reached a terminal state: cleanup or cancel. */
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

/** Tool events. The triage treats any one of them as a novel tool pattern. */
const TOOL_EVENT_TYPES = new Set([
  'tool.invoked',
  'tool.completed',
  'tool.errored',
]);

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
 * Scores the similarity of two records from 0 to 1, as the mean over all keys in either record.
 * A key scores 1 when both values match as strings, 0.5 when the values differ, and 0
 * when one record lacks it. Two empty records score 1.
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
        matches += 0.5;
      }
    }
  }

  return matches / allKeys.size;
}

/**
 * Returns true when, for any existing case, the mean of the `input` similarity and the
 * `expected` similarity reaches `threshold`.
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

/**
 * Sorts one workflow trace into regression candidates, capability candidates, or a discard.
 * An empty trace gives an empty result with `discarded: 0`. The rules apply in this order:
 * 1. A trace with fewer than 3 events, no completion event, or no captured case is a discard.
 * 2. A trace is a discard when every captured case duplicates an existing case.
 * 3. A retry event or any tool event makes the cases capability candidates.
 * 4. If every `gate.executed` event passed, the cases are regression candidates.
 * 5. Otherwise, the cases are capability candidates.
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

  if (traceEvents.length === 0) return empty;

  if (isTriviallyShort(traceEvents)) {
    return { ...empty, discarded: 1 };
  }

  if (!isWorkflowComplete(traceEvents)) {
    return { ...empty, discarded: 1 };
  }

  const captured = captureTrace(traceEvents, { skill: options.skill });

  if (captured.length === 0) {
    return { ...empty, discarded: 1 };
  }

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

/**
 * Returns the existing cases for deduplication. With a skill, it returns that dataset only.
 * Without a skill, it merges all datasets.
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
