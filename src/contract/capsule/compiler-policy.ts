/**
 * The closed version policy of a capsule compiler. Each consumer reads the policy of a compiler name here.
 * Compiler 8 and compiler 8-vcs get the immutable task semantics. Only compiler 8-vcs gets the integration terms.
 * Every other name keeps its historical meaning, and the decoder refuses no name.
 */

/** The name of the immutable compiler with no integration terms. Typed plans use it by default. */
export const IMMUTABLE_COMPILER_VERSION = 'exarchos-prepare-8';

/** The name of the immutable compiler that also pins the integration ref and binds the integration tip. */
export const INTEGRATION_COMPILER_VERSION = 'exarchos-prepare-8-vcs';

/** The historical names that require a full definition: compiler 7 and each later numbered compiler. */
const FULL_DEFINITION_NAME = /^exarchos-prepare-(?:[7-9]|[1-9][0-9]+)$/;

/** The semantics that one compiler name selects. */
export interface CompilerPolicy {
  /** Immutable task diffs, a full task graph, typed sources and frozen skips. */
  readonly immutable: boolean;
  /** The capsule pins an integration ref, and settle binds the integration tip. */
  readonly integration: boolean;
  /** A prepared record of this compiler requires a full definition. */
  readonly fullDefinition: boolean;
}

/**
 * The policy of one compiler name. A name that is absent or unknown gets the pre-immutable policy.
 * The full definition rule keeps each historical match and adds compiler 8-vcs.
 */
export function compilerPolicy(version: string | undefined): CompilerPolicy {
  if (version === INTEGRATION_COMPILER_VERSION) return { immutable: true, integration: true, fullDefinition: true };
  if (version === IMMUTABLE_COMPILER_VERSION) return { immutable: true, integration: false, fullDefinition: true };
  return { immutable: false, integration: false, fullDefinition: version !== undefined && FULL_DEFINITION_NAME.test(version) };
}
