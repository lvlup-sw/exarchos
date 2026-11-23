/**
 * Load stand-in for `@lvlup-sw/strategos-contracts` when that package is not installed.
 *
 * The invariant gate's module graph builds capsule schemas at import time. Those schemas are not
 * consulted when a review passes `repoRoot` and a diff. The shapes below are only enough for that
 * import to finish: optional string and array fields, which is what the derivation walker accepts.
 * A machine that has the real package resolves it instead.
 */
import { z } from 'zod';

const statement = z.object({
  id: z.string().optional(),
});

/** Authority statement object. The derivation closes it. */
export const WorkflowAuthorityStatementV1Schema = statement;

/** Authority block. Each category is an optional array, as the capsule derivation requires. */
export const WorkflowAuthorityV1Schema = z.object({
  invariants: z.array(statement).optional(),
  assumptions: z.array(statement).optional(),
  delegatedDecisions: z.array(statement).optional(),
  escalationBoundaries: z.array(statement).optional(),
  goals: z.array(statement).optional(),
});

/**
 * Definition object. Unknown keys are kept, and every top-level key of a built-in definition is
 * declared, so the extension's kernel-key check accepts those documents. `contentHash` stays an
 * optional string so the capsule digest unwrap succeeds.
 */
export const WorkflowDefinitionV1Schema = z.looseObject({
  contentHash: z.string().optional(),
  approvalPoints: z.unknown().optional(),
  authority: z.unknown().optional(),
  branchPoints: z.unknown().optional(),
  entryStepId: z.unknown().optional(),
  exarchos: z.unknown().optional(),
  failureHandlers: z.unknown().optional(),
  forkPoints: z.unknown().optional(),
  loops: z.unknown().optional(),
  name: z.unknown().optional(),
  schemaVersion: z.unknown().optional(),
  steps: z.unknown().optional(),
  transitions: z.unknown().optional(),
});
