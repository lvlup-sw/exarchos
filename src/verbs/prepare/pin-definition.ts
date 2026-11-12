/**
 * Pins the full definition of a workflow type, with its `exarchos` extension, for a capsule.
 *
 * The kernel schema keeps a key that it does not declare. So the parse keeps the extension, and the digest covers it.
 * An edit of the extension alone thus gives a new `definitionVersion`, and prepare compiles a new capsule version.
 * The definition in custody also carries the edge conditions of its workflow type.
 *
 * `lowerDefinition` stays the kernel projection. This function does not change it.
 */

import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';

import { contentDigest } from '../../contract/capsule/capsule-digest.js';
import type { ExarchosDefinition } from '../../workflow/definitions/extension.js';
import type { LoweredDefinition } from './lower-definition.js';

/**
 * Pin one checked definition of a workflow type with its extension.
 * The parse runs on a deep copy, so the pin shares no object with the definition of the caller.
 *
 * @throws When the definition fails the kernel contract.
 */
export function pinDefinition(workflowType: string, definition: ExarchosDefinition): LoweredDefinition {
  const parsed = WorkflowDefinitionV1Schema.safeParse(structuredClone(definition));
  if (!parsed.success) {
    throw new Error(
      `the pinned '${workflowType}' definition fails the published kernel contract: ${parsed.error.issues
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
