/**
 * The decision that admits the verification profile moves the digest of the prepared bundle only.
 * The prepared bundle embeds the capsule, and the capsule gains an optional profile.
 * The settlement bundle holds only the identity of its capsule, so it and the other stored shapes keep their digests.
 * The digest rule is the rule of `identifier-stability.test.ts`: the canonical JSON Schema with each description removed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { zodToJsonSchema } from '../../src/utils/json-schema.js';
import { requestDigest } from '../../src/contract/request-context.js';
import { SCHEMA_VERSION } from '../../src/storage/sqlite/schema.js';
import { ExecutionSettledData } from '../../src/events/schemas.js';
import { SettlementBundleV1Schema } from '../../src/verbs/settle/settlement-bundle.js';
import { ClaimTraceSchema } from '../../src/verbs/settle/claim-codec.js';
import { ExarchosCapsuleV1Schema } from '../../src/contract/capsule/exarchos-capsule.js';
import { ExecuteIntentRunBundleV1Schema } from '../../src/verbs/execute/run-bundle.js';
import { DesignTaskSchema } from '../../src/workflow/design-record/schema.js';
import { TaskCompletionArgs } from '../../src/verbs/execute/arg-schemas.js';
import { PreparedBundleV1Schema } from '../../src/verbs/prepare/prepared-record.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** The part of the snapshot that this test reads: the log of the stored-shape decisions. */
const StoredShapeLogSchema = z.object({
  storedShapes: z.object({
    decisions: z.array(
      z.object({
        date: z.string(),
        source: z.string(),
        decision: z.string(),
        schemaVersion: z.number(),
        shapes: z.record(z.string(), z.string()),
      }),
    ),
  }),
});

const decisions = StoredShapeLogSchema.parse(
  JSON.parse(readFileSync(path.join(REPO_ROOT, 'tools/audit/registered-actions-snapshot.json'), 'utf8')),
).storedShapes.decisions;

/** A copy of a JSON Schema with each description removed. A description is text for a reader and not part of the shape. */
function withoutDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutDescriptions);
  if (node === null || typeof node !== 'object') return node;
  const entries: [string, unknown][] = Object.entries(node);
  return Object.fromEntries(
    entries
      .filter(([key, value]) => !(key === 'description' && typeof value === 'string'))
      .map(([key, value]) => [key, withoutDescriptions(value)]),
  );
}

/** The digest of one stored shape. */
function shapeDigest(schema: z.ZodType): string {
  return requestDigest(withoutDescriptions(zodToJsonSchema(schema)));
}

/** The stored shapes that the profile does not change. */
const UNCHANGED_SHAPES: Readonly<Record<string, z.ZodType>> = {
  ClaimTraceSchema,
  ExecutionSettledData,
  SettlementBundleV1Schema,
};

describe('the stored-shape decision of the verification profile', () => {
  /**
   * The profile decision names the design of record and retains its historical digest.
   * The latest decision pins the live prepared bundle.
   */
  it('StoredShapes_TheProfileDecision_MovesOnlyThePreparedBundleDigest', () => {
    const scopeDecision = decisions.find((entry) => entry.date === '2026-10-25');
    const profileDecision = decisions.find((entry) => entry.date === '2026-10-29');
    expect(scopeDecision, 'the decision of 2026-10-25 is absent').toBeDefined();
    expect(profileDecision?.source).toContain('docs/specs/2026-10-28-no-per-language-code.md');
    expect(profileDecision?.decision).toContain('SCHEMA_VERSION stays 6');
    expect(profileDecision?.decision).toContain('`verificationProfile`');
    expect(profileDecision?.decision).toContain('`exarchos-prepare-5`');
    expect(profileDecision?.schemaVersion).toBe(SCHEMA_VERSION);

    for (const [name, schema] of Object.entries(UNCHANGED_SHAPES)) {
      if (name !== 'SettlementBundleV1Schema') expect(shapeDigest(schema), name).toBe(scopeDecision?.shapes[name]);
      expect(shapeDigest(schema), name).toBe(decisions.at(-1)?.shapes[name]);
      expect(profileDecision?.shapes[name], name).toBe(scopeDecision?.shapes[name]);
    }
    const prepared = shapeDigest(PreparedBundleV1Schema);
    expect(profileDecision?.shapes.PreparedBundleV1Schema).toBe('sha256:dadcc0ec285892340b8c27470379d548f54c7728fd98f015d978b4a3607f4823');
    expect(decisions.at(-1)?.shapes.PreparedBundleV1Schema).toBe(prepared);
    expect(prepared).not.toBe(scopeDecision?.shapes.PreparedBundleV1Schema);
    const entryDecision = decisions.find(entry => entry.date === '2026-11-13');
    expect(entryDecision?.source).toBe('S6 revision 4 accepted amendment A1, canonical spec SHA256 73aa11a32cae2853a6c58f9e27d7ac6e68562767762bce7c3c10408dd8ff9267');
    expect(entryDecision?.schemaVersion).toBe(6);
    expect(Object.keys(entryDecision?.shapes ?? {}).sort()).toEqual([
      'CapsuleSettlementContractSchema', 'ClaimTraceSchema', 'CustomWorkflowStateSchema',
      'DurableWorkflowTypeSchema', 'ExarchosCapsuleV1Schema', 'ExecutionSettledData',
      'PreparedBundleV1Schema', 'SettlementBundleV1Schema', 'SettlementReceiptData',
      'WorkflowPreparedData', 'WorkflowStartedData', 'WorkflowStartedV11Data', 'WorkflowStateSchema',
    ]);
    expect(entryDecision?.shapes.PreparedBundleV1Schema).toBe('sha256:a9449d8eaacb8bbe862150ab91c9ab2a20433a85bc71e12a0c550d85424b4610');
    expect(entryDecision?.shapes.ExarchosCapsuleV1Schema).toBe('sha256:72381c09521c02845b431f14a62d3540f632bee7f7bd9329d64dbf8b8a1ce044');
    expect(Object.keys(ExarchosCapsuleV1Schema.shape.graph.shape.tasks.element.shape).sort()).toEqual([
      'stage', 'stepId', 'taskContext', 'taskId', 'title',
    ]);
    expect(Object.keys(ExarchosCapsuleV1Schema.shape.graph.shape.joins.element.shape).sort()).toEqual([
      'forTaskId', 'joinId', 'mode', 'waitsFor',
    ]);
    expect(Object.keys(DesignTaskSchema.shape).sort()).toEqual([
      'acceptance', 'blockedBy', 'boundaryTouching', 'files', 'id', 'implements', 'instructions',
      'knowledgeSlice', 'parallelizable', 'riskTier', 'testFiles', 'testLayer', 'title',
    ]);
    expect(Object.keys(TaskCompletionArgs.shape).sort()).toEqual([
      'baseRef', 'boundaryTouching', 'branch', 'capsuleVersion', 'result', 'riskTier', 'taskId', 'worktreePath',
    ]);
    expect(Object.keys(ExecuteIntentRunBundleV1Schema.shape).sort()).toEqual([
      'bundleVersion', 'failedLeaf', 'failure', 'input', 'intent', 'interaction', 'kind', 'leaves',
      'operationId', 'outcome', 'requestDigest', 'steering', 'streamId', 'tailSequence',
    ]);
    expect(Object.keys(SettlementBundleV1Schema.shape.verification.unwrap().element.shape).sort()).toEqual([
      'bundleRefs', 'coordinate', 'failedLeaf', 'message', 'operationId', 'outcome', 'taskId', 'treeCommit',
    ]);
  });
});
