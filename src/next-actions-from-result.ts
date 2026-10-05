/**
 * Derives the `NextAction[]` of a `ToolResult`. `envelopeWrap` calls it for the four composite
 * tools. When the payload carries workflow context, the helper looks up the HSM for the workflow
 * type and returns the outbound transitions from `computeNextActions`. Otherwise it returns `[]`.
 *
 * An unknown workflow type gives `[]` and does not throw. The HSM registry is mutable (see
 * `registerWorkflowType`), so a stale reference must not break the envelope.
 */

import { z } from 'zod';
import type { ToolResult } from './format.js';
import { logger } from './logger.js';
import type { NextAction, RegistryAdvertisement } from './next-action.js';
import {
  computeNextActionEnvelopes,
  computeNextActions,
  type ActionAdmissionFacts,
  type AdmissionFacts,
  type NextActionEnvelopes,
  type NextActionsState,
} from './next-actions-computer.js';
import {
  RehydrationMergeOrchestratorSchema,
  WorkflowStateSchema,
} from './projections/rehydration/schema.js';
import { getHSMDefinition } from './workflow/state-machine.js';

/** Logger for fail-closed parse warnings. It is exported so unit tests can spy on `warn`. */
export const nextActionsLogger = logger.child({ subsystem: 'next-actions' });

/**
 * Shape 1: the handler payload of `handleInit`, `handleGet` and `handleSet`. `.passthrough()`
 * keeps the other handler fields, and the schema validates only the fields that this helper reads.
 */
export const ShapeOneSchema = z
  .object({
    phase: z.string(),
    workflowType: z.string(),
    featureId: z.string().optional(),
    mergeOrchestrator: RehydrationMergeOrchestratorSchema.optional(),
    /**
     * `updatedAt`, `artifacts`, `tasks` and `reviews` mark a full workflow-state read. They are
     * `unknown` because `projectStateToFacts` owns their shape. A second declaration here forks
     * the fact vocabulary, and a state-schema change then empties `next_actions`.
     * `admissionFactsFrom` decides if they are usable.
     */
    updatedAt: z.unknown().optional(),
    artifacts: z.unknown().optional(),
    tasks: z.unknown().optional(),
    reviews: z.unknown().optional(),
    /** ActionId advertisement inputs. They are `unknown`, so this parse does not fork the vocabulary. */
    evidence: z.unknown().optional(),
    authorization: z.unknown().optional(),
    stream: z.unknown().optional(),
    phaseAttemptId: z.unknown().optional(),
  })
  .passthrough();

/** Shape 2: the rehydration document of `handleRehydrate`. */
export const ShapeTwoSchema = z
  .object({
    workflowState: WorkflowStateSchema,
  })
  .passthrough();

/** The two recognized workflow-context payload shapes. */
export const ResultDataSchema = z.union([ShapeOneSchema, ShapeTwoSchema]);

export type ResultData = z.infer<typeof ResultDataSchema>;

/**
 * Discriminator keys of shape 1. A payload advertises a shape when it carries every key of that
 * shape, and an advertised shape must then parse. A check on some keys is wrong: `handleCheckpoint`
 * and the idempotent `handleSet` return `{ phase }` without `workflowType`. Such a receipt then
 * fails the parse and logs a false "malformed" warning.
 */
const SHAPE_ONE_DISCRIMINATOR_KEYS = ['phase', 'workflowType'] as const;
/** Discriminator keys of shape 2. */
const SHAPE_TWO_DISCRIMINATOR_KEYS = ['workflowState'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extracts the admission facts from a shape-1 payload, or `undefined` when the payload is not a
 * full state read. A `fields` projection or a `query` scalar from `handleGet` lacks the facts that
 * it did not request. Admission over such a payload denies almost every edge.
 * `BaseWorkflowStateSchema` requires the four marker keys, so a full state always has them.
 *
 * `updatedAt` is the evaluation instant, so the helper reads no clock and stays deterministic.
 * `eventLogAvailable` is always `false`, because a handler payload does not carry the event log.
 * Thus `adjudicateOutboundEdges` reports log-decided edges as undecidable and keeps them.
 */
function admissionFactsFrom(
  data: z.infer<typeof ShapeOneSchema>,
): AdmissionFacts | undefined {
  const { updatedAt, artifacts, tasks, reviews } = data;
  if (typeof updatedAt !== 'string' || updatedAt.trim().length === 0) {
    return undefined;
  }
  if (!isRecord(artifacts) || !Array.isArray(tasks) || !isRecord(reviews)) {
    return undefined;
  }
  return {
    state: data as Record<string, unknown>,
    evaluatedAt: updatedAt,
    eventLogAvailable: false,
  };
}

/**
 * Extracts the ActionId advertisement facts from a shape-1 payload. It needs a `featureId` and an
 * `evidence` array. `authorization` can be absent, so capability-gated ActionIds are left out and
 * do not fail open. A shape-2 rehydration document gives topology only.
 */
function actionAdmissionFrom(
  data: z.infer<typeof ShapeOneSchema>,
  phase: string,
  featureId: string | undefined,
): ActionAdmissionFacts | undefined {
  if (featureId === undefined || featureId.trim().length === 0) return undefined;
  if (!Array.isArray(data.evidence)) return undefined;
  const stream =
    typeof data.stream === 'string' && data.stream.trim().length > 0
      ? data.stream
      : featureId;
  const phaseAttemptId =
    typeof data.phaseAttemptId === 'string' && data.phaseAttemptId.trim().length > 0
      ? data.phaseAttemptId
      : undefined;
  return {
    subject: { featureId, stream },
    evidence: data.evidence,
    ...(data.authorization === undefined ? {} : { authorization: data.authorization }),
    hsmFacts:
      phaseAttemptId === undefined ? { phase } : { phase, phaseAttemptId },
  };
}

/**
 * Computes the outbound `NextAction[]` for the HSM phase of a successful `ToolResult`. A payload
 * without a discriminator key, such as a describe or view response, gives `[]` with no warning.
 * An advertised shape that fails its parse logs a warning and gives `[]`. The function parses each
 * advertised shape on its own, because a union parse accepts a valid shape 1 beside a malformed
 * `workflowState`.
 *
 * Shape 1 has precedence. Shape 2 fills the missing fields, so the `mergeOrchestrator` of a
 * rehydration document can surface `merge_orchestrate`. Admission facts come from shape 1 only:
 * the rehydration document has no `reviews` and no event log, and facts from it deny legal edges.
 */
export function nextActionsFromResult(result: ToolResult): readonly NextAction[] {
  if (!result.success) return [];
  const data = result.data;
  if (data === null || data === undefined || typeof data !== 'object') return [];

  const shapeOneAdvertised = SHAPE_ONE_DISCRIMINATOR_KEYS.every((k) =>
    Reflect.has(data, k),
  );
  const shapeTwoAdvertised = SHAPE_TWO_DISCRIMINATOR_KEYS.every((k) =>
    Reflect.has(data, k),
  );
  if (!shapeOneAdvertised && !shapeTwoAdvertised) return [];

  const shapeOne = shapeOneAdvertised ? ShapeOneSchema.safeParse(data) : null;
  const shapeTwo = shapeTwoAdvertised ? ShapeTwoSchema.safeParse(data) : null;

  if ((shapeOne && !shapeOne.success) || (shapeTwo && !shapeTwo.success)) {
    nextActionsLogger.warn(
      {
        issues: [
          ...(shapeOne && !shapeOne.success ? shapeOne.error.issues : []),
          ...(shapeTwo && !shapeTwo.success ? shapeTwo.error.issues : []),
        ],
        shapeOneAdvertised,
        shapeTwoAdvertised,
      },
      'malformed result.data — advertised shape failed safeParse; returning [].',
    );
    return [];
  }

  let phase: string | undefined;
  let workflowType: string | undefined;
  let featureId: string | undefined;
  let mergeOrchestrator: { taskId?: string; phase?: string } | undefined;
  let admission: AdmissionFacts | undefined;
  let actionAdmission: ActionAdmissionFacts | undefined;

  if (shapeOne?.success) {
    phase = shapeOne.data.phase;
    workflowType = shapeOne.data.workflowType;
    featureId = shapeOne.data.featureId;
    mergeOrchestrator = shapeOne.data.mergeOrchestrator;
    admission = admissionFactsFrom(shapeOne.data);
    actionAdmission = actionAdmissionFrom(shapeOne.data, shapeOne.data.phase, featureId);
  }

  if (shapeTwo?.success) {
    const ws = shapeTwo.data.workflowState;
    if (!phase) phase = ws.phase;
    if (!workflowType) workflowType = ws.workflowType;
    if (!featureId) featureId = ws.featureId;
    if (mergeOrchestrator === undefined && ws.mergeOrchestrator !== undefined) {
      mergeOrchestrator = ws.mergeOrchestrator;
    }
  }

  if (!phase || !workflowType) return [];

  let hsm;
  try {
    hsm = getHSMDefinition(workflowType);
  } catch {
    return [];
  }

  return computeNextActions(
    { phase, workflowType, featureId, mergeOrchestrator, admission, actionAdmission },
    hsm,
  );
}

function nextActionsStateFromResult(result: ToolResult): {
  readonly state: NextActionsState;
  readonly hsm: ReturnType<typeof getHSMDefinition>;
} | undefined {
  if (!result.success) return undefined;
  const data = result.data;
  if (data === null || data === undefined || typeof data !== 'object') return undefined;

  const shapeOneAdvertised = SHAPE_ONE_DISCRIMINATOR_KEYS.every((k) =>
    Reflect.has(data, k),
  );
  const shapeTwoAdvertised = SHAPE_TWO_DISCRIMINATOR_KEYS.every((k) =>
    Reflect.has(data, k),
  );
  if (!shapeOneAdvertised && !shapeTwoAdvertised) return undefined;

  const shapeOne = shapeOneAdvertised ? ShapeOneSchema.safeParse(data) : null;
  const shapeTwo = shapeTwoAdvertised ? ShapeTwoSchema.safeParse(data) : null;
  if ((shapeOne && !shapeOne.success) || (shapeTwo && !shapeTwo.success)) {
    return undefined;
  }

  let phase: string | undefined;
  let workflowType: string | undefined;
  let featureId: string | undefined;
  let mergeOrchestrator: { taskId?: string; phase?: string } | undefined;
  let admission: AdmissionFacts | undefined;
  let actionAdmission: ActionAdmissionFacts | undefined;

  if (shapeOne?.success) {
    phase = shapeOne.data.phase;
    workflowType = shapeOne.data.workflowType;
    featureId = shapeOne.data.featureId;
    mergeOrchestrator = shapeOne.data.mergeOrchestrator;
    admission = admissionFactsFrom(shapeOne.data);
    actionAdmission = actionAdmissionFrom(shapeOne.data, shapeOne.data.phase, featureId);
  }

  if (shapeTwo?.success) {
    const ws = shapeTwo.data.workflowState;
    if (!phase) phase = ws.phase;
    if (!workflowType) workflowType = ws.workflowType;
    if (!featureId) featureId = ws.featureId;
    if (mergeOrchestrator === undefined && ws.mergeOrchestrator !== undefined) {
      mergeOrchestrator = ws.mergeOrchestrator;
    }
  }

  if (!phase || !workflowType) return undefined;

  let hsm;
  try {
    hsm = getHSMDefinition(workflowType);
  } catch {
    return undefined;
  }

  return {
    state: { phase, workflowType, featureId, mergeOrchestrator, admission, actionAdmission },
    hsm,
  };
}

/**
 * Both next-action envelopes from a successful tool result. Control verbs follow HSM topology,
 * and registry ActionIds publish only on allow.
 */
export function nextActionEnvelopesFromResult(result: ToolResult): NextActionEnvelopes {
  const parsed = nextActionsStateFromResult(result);
  if (parsed === undefined) return { control: [], registry: [] };
  return computeNextActionEnvelopes(parsed.state, parsed.hsm);
}

/** Allow-only registry ActionIds from a successful tool result. */
export function registryAdvertisementsFromResult(
  result: ToolResult,
): readonly RegistryAdvertisement[] {
  return nextActionEnvelopesFromResult(result).registry;
}
