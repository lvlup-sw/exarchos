/** Hand-authored records bind a one-frontier capsule to a complete plan. */
import { createHash } from 'node:crypto';
import { capsuleDigest, contentDigest } from '../../../src/contract/capsule/capsule-digest.js';
import { baseValidCapsule } from '../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import type { PreparedBundleV1 } from '../../../src/contract/capsule/prepared-bundle.js';
import { WorkflowPreparedData, type WorkflowEvent } from '../../../src/events/schemas.js';
import { builtInDefinition } from '../../../src/workflow/definitions/built-in.js';
import type { DesignTask } from '../../../src/workflow/design-record/schema.js';

export function task(id: string, patch: Partial<DesignTask> = {}): DesignTask {
  return { id, title: id, implements: ['DR-1'], blockedBy: [], files: [`${id}.ts`], testFiles: [], riskTier: 'low',
    boundaryTouching: false, testLayer: 'unit', acceptance: ['Works.'], instructions: 'Build it.', parallelizable: false, ...patch };
}
export function textOf(tasks = [task('task-compile'), task('task-verify', { blockedBy: ['task-compile'] }), task('later')]): string {
  return `## Design & Rationale\n### DR-1: Requirement\nKeep all work.\n## Tasks\n\`\`\`exarchos-plan-v1\n${JSON.stringify({ version: 1, requirements: ['DR-1'], tasks })}\n\`\`\`\n`;
}
export function fixture(text = textOf(), typed = true): PreparedBundleV1 {
  const definition = builtInDefinition('feature');
  const capsule = structuredClone(baseValidCapsule());
  return { definition, capsule: { ...capsule, identity: { ...capsule.identity, definitionVersion: contentDigest(definition) },
    provenance: { ...capsule.provenance, compilerVersion: 'exarchos-prepare-7', sources: [
      { sourceId: 'workflow-definition', digest: contentDigest(definition) },
      { sourceId: 'design-record', digest: createHash('sha256').update(text).digest('hex') },
    ] }, settlementContract: { ...capsule.settlementContract, skipPhases: [] } },
    ...(typed ? { designRecord: { reference: 'unavailable/plan.md', text } } : {}) };
}
export function row(sequence: number, type: string, data: Record<string, unknown>): WorkflowEvent {
  return { streamId: 'wf-capsule-corpus', sequence, timestamp: '2026-11-13T00:00:00.000Z', type, schemaVersion: '1.0', data };
}
export function prepared(bundle = fixture(), sequence = 1): WorkflowEvent {
  const c = bundle.capsule;
  return row(sequence, 'workflow.prepared', WorkflowPreparedData.parse({ operationId: 'prepare:fixture', workflowId: c.identity.workflowId,
    workflowType: 'feature', capsuleVersion: c.identity.capsuleVersion, definitionVersion: c.identity.definitionVersion,
    designVersion: c.identity.designVersion, capsuleDigest: capsuleDigest(c), compilerVersion: c.provenance.compilerVersion,
    taskCount: c.graph.tasks.length, requestDigest: 'request',
    ...(bundle.designRecord ? { planRecordDigest: createHash('sha256').update(bundle.designRecord.text).digest('hex') } : {}),
    bundleRefs: [{ artifactId: 'run-bundle:fixture', digest: { algorithm: 'sha256', value: 'a'.repeat(64) } }] }));
}
