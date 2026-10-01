/**
 * The `RuntimeAdapter` port. Each per-runtime adapter lowers a domain-language
 * `AgentSpec` into a runtime-specific agent definition file with `lowerSpec`.
 * `validateSupport` checks that the runtime supports the capabilities of a spec.
 */

import type { AgentSpec } from '../types.js';
import type { Capability } from '../capabilities.js';

/** Tier-1 runtime identifiers. Excludes the `generic` skill-render target. */
export type Runtime = 'claude' | 'codex' | 'opencode' | 'cursor' | 'copilot';

/**
 * Coverage of a capability by a runtime.
 *
 *   - `native`: the runtime has a primitive for the capability.
 *     `lowerSpec` emits a tool or frontmatter entry for it.
 *   - `advisory`: the adapter accepts the capability without error, but the runtime
 *     cannot enforce or expose it. `lowerSpec` emits no entry for it.
 *   - `unsupported`: `validateSupport` rejects a spec that declares the capability.
 */
export type SupportLevel = 'native' | 'advisory' | 'unsupported';

/** Canonical, ordered enumeration of tier-1 runtimes. */
export const RUNTIMES = [
  'claude',
  'codex',
  'opencode',
  'cursor',
  'copilot',
] as const satisfies readonly Runtime[];

/** Result of validating that a runtime supports a given spec. */
export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; fixHint: string };

/**
 * Port that all per-runtime adapters implement. Adapters translate a
 * runtime-agnostic `AgentSpec` into a runtime-specific agent definition
 * file, and gate dispatch on capability support for the target runtime.
 */
export interface RuntimeAdapter {
  /** Runtime identifier this adapter targets. */
  readonly runtime: Runtime;

  /**
   * Support level for each capability. Each value of the `Capability` enum
   * must appear as a key. `validateSupport` rejects a spec that declares an
   * `unsupported` capability. `lowerSpec` emits entries for `native` capabilities only.
   */
  readonly supportLevels: Readonly<Record<Capability, SupportLevel>>;

  /**
   * Path (relative to repo root or user home, per runtime convention)
   * where the agent definition file is written.
   */
  agentFilePath(agentName: string): string;

  /**
   * Lower a domain-language `AgentSpec` into a runtime-specific agent
   * definition file (path + contents).
   */
  lowerSpec(spec: AgentSpec): { path: string; contents: string };

  /** Validate that this runtime supports the spec's declared capabilities. */
  validateSupport(spec: AgentSpec): ValidationResult;
}
