/**
 * Capability resolver (T017, DR-14)
 *
 * Stub for runtime capability detection. Real runtime handshake wiring is a
 * follow-up task; this module provides only an in-memory lookup surface.
 *
 * Consumers should depend on the {@link CapabilityResolver} interface rather
 * than the concrete factory so that the resolver can be swapped for a real
 * handshake-based implementation later.
 */

import type { Capability } from '../agents/capabilities.js';
import type { AgentPosture } from '../agents/spec.js';
import { capabilitiesForPosture } from './posture-mapping.js';

export interface CapabilityResolver {
  has(capability: string): boolean;
  list(): readonly string[];
}

export function createInMemoryResolver(
  capabilities: Iterable<string>,
): CapabilityResolver {
  const set = new Set(capabilities);
  return {
    has(capability) {
      return set.has(capability);
    },
    list() {
      return [...set];
    },
  };
}

export const ANTHROPIC_NATIVE_CACHING = 'anthropic_native_caching' as const;

// ─── #1262 Quality-hint threshold resolver ──────────────────────────────────

/**
 * Per-turn output-token cap (matches the upper bound that Anthropic's
 * sampling layer permits today). The `output_tokens_high` quality hint
 * fires when a turn's `outputTokens` exceeds
 * `cap * outputTokenThreshold`. Surfaced as a constant so tests can pin
 * the multiplication and the cap can be bumped centrally if the model
 * surface changes.
 */
export const OUTPUT_TOKENS_PER_TURN_CAP = 32000;

/**
 * Default threshold fraction (`0.8` = 80% of `OUTPUT_TOKENS_PER_TURN_CAP`).
 * Overridden by `.exarchos.yml` → `qualityHints.outputTokenThreshold`.
 */
export const DEFAULT_OUTPUT_TOKEN_THRESHOLD_FRACTION = 0.8;

/**
 * Slice of `.exarchos.yml` consumed by {@link getQualityHintThreshold}.
 * We accept a structurally-typed shape (rather than importing the full
 * `ExarchosConfig` Zod type) to avoid a circular import between the
 * resolver and the config schema and to keep the resolver consumable from
 * tests without spinning up a config loader.
 */
export interface QualityHintsConfig {
  readonly qualityHints?: {
    readonly outputTokenThreshold?: number;
  };
}

/**
 * Return the absolute token threshold (in tokens) for a named quality
 * hint, derived from the `.exarchos.yml` configuration when supplied or
 * the resolver default otherwise.
 *
 * Currently only `'output_tokens'` is supported — the function returns
 * `cap * fraction` where `fraction` is either the configured value or
 * {@link DEFAULT_OUTPUT_TOKEN_THRESHOLD_FRACTION}. Unknown names return
 * the default product so callers never see `NaN`/`undefined` when a new
 * hint id is referenced before its threshold lands.
 */
export function getQualityHintThreshold(
  name: 'output_tokens' | (string & {}),
  config?: QualityHintsConfig,
): number {
  const fraction =
    config?.qualityHints?.outputTokenThreshold ?? DEFAULT_OUTPUT_TOKEN_THRESHOLD_FRACTION;
  if (name === 'output_tokens') {
    return OUTPUT_TOKENS_PER_TURN_CAP * fraction;
  }
  // Unknown hint name — fall back to the same product so callers get a
  // numeric value rather than `undefined`. Future hint families can fan
  // out into a per-name switch here.
  return OUTPUT_TOKENS_PER_TURN_CAP * fraction;
}

/**
 * Capabilities in the `mcp:exarchos` family. The resolver treats this family
 * as a tiered set: a single tier wins (handshake authoritative) rather than
 * being unioned, so an agent never simultaneously holds the full and readonly
 * tiers.
 */
const MCP_EXARCHOS_FAMILY: ReadonlySet<Capability> = new Set<Capability>([
  'mcp:exarchos',
  'mcp:exarchos:readonly',
]);

function isMcpExarchosFamily(cap: Capability): boolean {
  return MCP_EXARCHOS_FAMILY.has(cap);
}

function uniqueMcpTiers(caps: readonly Capability[]): Capability[] {
  const seen = new Set<Capability>();
  for (const c of caps) {
    if (isMcpExarchosFamily(c)) seen.add(c);
  }
  return [...seen];
}

/**
 * Per ADR ontological-data-fabric §2.8: capability resolution is
 * handshake-authoritative. For the `mcp:exarchos` family, the handshake
 * tier wins over yaml even when narrower. This prevents runtime widening
 * of trust boundaries via stale yaml defaults — if the handshake declares
 * `mcp:exarchos:readonly` while yaml declares `mcp:exarchos` (full), the
 * effective record is `mcp:exarchos:readonly`. Conversely, if the handshake
 * declares the full tier while yaml is narrower, the handshake still wins
 * (the runtime is the source of truth for what is actually mounted).
 *
 * Other capability families (fs:read, fs:write, shell:exec, isolation:*,
 * etc.) merge by union — handshake additions widen the set; yaml-declared
 * caps are preserved.
 *
 * The returned set is frozen to prevent downstream mutation of the trust
 * boundary after resolution.
 */
export function resolveEffectiveCapabilities(
  yamlCaps: readonly Capability[],
  handshakeCaps: readonly Capability[],
): ReadonlySet<Capability> {
  const effective = new Set<Capability>();

  // Non-mcp:exarchos: union (handshake additions widen).
  for (const c of yamlCaps) {
    if (!isMcpExarchosFamily(c)) effective.add(c);
  }
  for (const c of handshakeCaps) {
    if (!isMcpExarchosFamily(c)) effective.add(c);
  }

  // mcp:exarchos family: handshake authoritative — pick the handshake's
  // declared tier if present; otherwise fall back to yaml's declared tier.
  //
  // Fail closed when a single source declares more than one distinct tier
  // (e.g., both `mcp:exarchos` and `mcp:exarchos:readonly`). Silently
  // picking by array order would let a misconfigured spec hand out broader
  // privileges than intended. Reject the session instead so the operator
  // sees the contradiction.
  const handshakeMcpTiers = uniqueMcpTiers(handshakeCaps);
  if (handshakeMcpTiers.length > 1) {
    throw new Error(
      `Capability resolution failed: handshake declares conflicting mcp:exarchos tiers (${handshakeMcpTiers.join(', ')}). Pick exactly one.`,
    );
  }
  const yamlMcpTiers = uniqueMcpTiers(yamlCaps);
  if (yamlMcpTiers.length > 1) {
    throw new Error(
      `Capability resolution failed: runtime YAML declares conflicting mcp:exarchos tiers (${yamlMcpTiers.join(', ')}). Pick exactly one.`,
    );
  }
  if (handshakeMcpTiers.length === 1) {
    effective.add(handshakeMcpTiers[0]);
  } else if (yamlMcpTiers.length === 1) {
    effective.add(yamlMcpTiers[0]);
  }

  return freezeSet(effective);
}

// ─── T33 / DR-6: posture-driven resolution ────────────────────────────────

/**
 * Minimal posture-bearing slice of an AgentSpec. The full spec carries more
 * fields (id, prompt, etc.) — `resolvePosture` only depends on `posture`.
 */
export interface PostureSpec {
  readonly posture?: AgentPosture;
}

/**
 * Runtime handshake input to `resolvePosture`. The handshake is the
 * authoritative half of `yaml ⊕ handshake` — declarations here override
 * posture-derived capabilities (DR-6 acceptance question 1 of INV-3).
 *
 * Three optional fields:
 *   - `capabilities`: backwards-compatible flat list (treated as `allow`).
 *   - `allow`: capabilities the handshake explicitly grants.
 *   - `deny`: capabilities the handshake explicitly revokes (override-wins).
 *
 * Coordinates with #1139 — keep this shape stable. If extended, document
 * the addition here and flag it in the resolver's JSDoc.
 */
export interface RuntimeHandshake {
  readonly capabilities?: readonly Capability[];
  readonly allow?: readonly Capability[];
  readonly deny?: readonly Capability[];
}

/**
 * `EffectiveCapabilities` is the immutable, frozen set returned to callers
 * after `yaml ⊕ handshake` resolution. The shape is `ReadonlySet<Capability>`
 * — coordinated with #1139's consumer. If the shape changes, update the
 * coordination contract there.
 */
export type EffectiveCapabilities = ReadonlySet<Capability>;

/**
 * Resolve a spec's posture to an `EffectiveCapabilities` set, then layer the
 * runtime handshake on top per `yaml ⊕ handshake` semantics.
 *
 * Merge order (load-bearing for INV-3 — basileus-forward):
 *   1. Start from the posture-derived capability set (yaml half).
 *   2. Union `handshake.capabilities` and `handshake.allow` (additive).
 *   3. Subtract `handshake.deny` LAST so handshake denies override the
 *      posture's grants. Handshake wins on conflicts.
 *
 * If the spec declares no posture, the function returns a frozen set
 * containing only the handshake's allow/capabilities (minus its denies).
 *
 * The returned set is frozen; mutators throw.
 */
export function resolvePosture(
  spec: PostureSpec,
  handshake: RuntimeHandshake,
): EffectiveCapabilities {
  const effective = new Set<Capability>();

  // (1) Posture-derived caps (yaml half of yaml ⊕ handshake).
  if (spec.posture !== undefined) {
    for (const c of capabilitiesForPosture(spec.posture)) {
      effective.add(c);
    }
  }

  // (2) Handshake-declared additions (union).
  if (handshake.capabilities !== undefined) {
    for (const c of handshake.capabilities) effective.add(c);
  }
  if (handshake.allow !== undefined) {
    for (const c of handshake.allow) effective.add(c);
  }

  // (3) Handshake-declared denies LAST — handshake wins on conflict
  // (DR-6, INV-3). Even if the posture grants `fs:write`, an explicit
  // handshake `deny: ['fs:write']` revokes it. This ordering is the
  // structural enforcement of "handshake declarations override resolved
  // capabilities."
  if (handshake.deny !== undefined) {
    for (const c of handshake.deny) effective.delete(c);
  }

  return freezeSet(effective);
}

/**
 * Return a frozen Set whose mutators throw. `Object.freeze(set)` alone is
 * insufficient because Set's internal slots ignore the frozen flag — `.add`
 * still mutates. We replace mutators with throwing stubs and freeze the
 * object identity so downstream code cannot widen the trust boundary after
 * resolution.
 */
function freezeSet<T>(set: Set<T>): ReadonlySet<T> {
  const throwImmutable = (): never => {
    throw new TypeError(
      'resolveEffectiveCapabilities returned an immutable set; mutation is forbidden',
    );
  };
  Object.defineProperty(set, 'add', { value: throwImmutable, writable: false, configurable: false });
  Object.defineProperty(set, 'delete', { value: throwImmutable, writable: false, configurable: false });
  Object.defineProperty(set, 'clear', { value: throwImmutable, writable: false, configurable: false });
  return Object.freeze(set);
}
