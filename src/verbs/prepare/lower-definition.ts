/**
 * Lowers a workflow definition into a published kernel definition at compile time.
 *
 * A capsule names its definition by digest, so settlement knows the definition
 * that the work ran under. The kernel comes from the authored definition of the
 * type. The lowering removes the `exarchos` extension and parses the rest with
 * the kernel schema:
 *
 * - The steps, the transitions, the entry step and the authority are the kernel
 *   part of the authored file, in the order of that file.
 * - Guards do not survive. They live in the extension, and the kernel gate
 *   vocabulary has no slot for these obligations. A guard in a shape with a
 *   different meaning is worse than none. Obligations reach a capsule through
 *   its completion predicate.
 *
 * A registered definition lowers the same way. Its digest covers its kernel only, as the digest of a built-in does.
 */

import {
  WorkflowDefinitionV1Schema,
  type WorkflowDefinitionV1,
} from '@lvlup-sw/strategos-contracts';

import { contentDigest } from '../../contract/capsule/capsule-digest.js';
import {
  builtInDefinition,
  isBuiltInDefinitionType,
  kernelOf,
} from '../../workflow/definitions/built-in.js';
import type { ExarchosDefinition } from '../../workflow/definitions/extension.js';

export interface LoweredDefinition {
  readonly workflowType: string;
  readonly definition: WorkflowDefinitionV1;
  /** Bare hex over the definition's canonical JSON — the digest a capsule pins. */
  readonly definitionVersion: string;
}

/**
 * Lower one checked definition of a workflow type into a kernel definition.
 *
 * @throws When the kernel part of the definition fails the kernel contract.
 */
export function lowerDefinition(workflowType: string, definition: ExarchosDefinition): LoweredDefinition {
  const parsed = WorkflowDefinitionV1Schema.safeParse(kernelOf(definition));
  if (!parsed.success) {
    throw new Error(
      `the lowered '${workflowType}' definition fails the published kernel contract: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return {
    workflowType,
    definition: parsed.data,
    definitionVersion: contentDigest(parsed.data),
  };
}

/**
 * Lower one built-in workflow into a kernel definition, or return `undefined`
 * for a type with no authored built-in definition.
 *
 * @throws When the kernel part of the authored definition fails the kernel contract.
 */
export function lowerBuiltInDefinition(workflowType: string): LoweredDefinition | undefined {
  if (!isBuiltInDefinitionType(workflowType)) return undefined;
  return lowerDefinition(workflowType, builtInDefinition(workflowType));
}
