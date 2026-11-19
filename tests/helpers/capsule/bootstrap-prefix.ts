/** Authored inputs for pure bootstrap planner tests. */
import { buildValidatedEvent } from '../../../src/events/event-factory.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { builtInDefinition } from '../../../src/workflow/definitions/built-in.js';
import type { ExarchosDefinition } from '../../../src/workflow/definitions/extension.js';
import type { BootstrapPlanInput } from '../../../src/workflow/design-record/bootstrap-plan.js';
import { readDesignRecord } from '../../../src/workflow/design-record/read.js';
import type { DesignRecordSnapshot } from '../../../src/workflow/design-record/schema.js';
import { task, textOf } from './prepared-authority.js';
import { nodeTestProfile } from '../verification-profile.js';

export const INITIAL_ATTEMPT = '0f8e2b7c-4d1a-4c3e-9b6f-2a5d8c7e1f30';
export const STREAM = 'bootstrap-prefix';
export const REFERENCE = 'docs/plan.md';
const STAMP = '2026-11-13T00:00:00.000Z';

/** Parse the same authored bytes for the approval and the plan checks. */
export function snapshot(testFiles = ['tests/compile.test.ts'], preamble = ''): DesignRecordSnapshot {
  const bytes = Buffer.from(preamble + textOf([task('task-compile', { testFiles })]));
  const record = readDesignRecord(bytes, REFERENCE);
  if (record.kind !== 'typed') throw new Error(JSON.stringify(record));
  return record.snapshot;
}

/** Build the exact new start and the initial compatibility patch. */
export function seed(
  workflowType: string,
  definition: ExarchosDefinition,
  record: DesignRecordSnapshot,
): readonly [WorkflowEvent, WorkflowEvent] {
  const compatibility = {
    'artifacts.design': record.reference,
    'artifacts.plan': record.reference,
    'planReview.approved': true,
    'synthesis.integrationBranch': 'codex/integration',
    ...(workflowType === 'refactor' ? { 'explore.scopeAssessment': 'Cross-cutting refactor', track: 'overhaul' } : {}),
  };
  return [
    buildValidatedEvent(STREAM, 1, {
      type: 'workflow.started',
      schemaVersion: '1.1',
      timestamp: STAMP,
      data: { featureId: STREAM, repoRoot: 'test/repository', workflowType,
        initialPhase: definition.entryStepId, phaseAttemptId: INITIAL_ATTEMPT },
    }),
    buildValidatedEvent(STREAM, 2, {
      type: 'state.patched',
      timestamp: STAMP,
      data: { fields: Object.keys(compatibility), patch: compatibility },
    }),
  ];
}

/** Make a planner input with no store or file reads. */
export function prefixInput(
  workflowType = 'feature',
  definition = builtInDefinition('feature'),
  record = snapshot(),
): BootstrapPlanInput {
  return {
    workflowType, definition, snapshot: record, approvedDigest: record.digest,
    designDepth: 'standard', profile: nodeTestProfile(), skipPhases: [],
    seed: seed(workflowType, definition, record),
  };
}
