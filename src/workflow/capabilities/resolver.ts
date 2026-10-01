/**
 * The capability resolver: an in-memory capability lookup and the snapshot of the client handshake.
 * Consumers depend on the {@link CapabilityResolver} interface, not on a concrete factory.
 */

import { Capability as CapabilitySchema, type Capability } from '../../runtime/agents/capabilities.js';
import type { AgentPosture } from '../../runtime/agents/spec.js';
import type { ToolResult } from '../../format.js';
import { capabilitiesForPosture } from './posture-mapping.js';
import { KIND_OBLIGATIONS } from '../phase-kind.js';
import type { PhaseKind } from '../phase-kind.js';

/**
 * The part of the MCP initialize handshake that {@link CapabilityResolver.snapshot} reads.
 * The shape is structural, so a caller can pass the raw handshake.
 * A client declares `roots` as `capabilities.roots: { listChanged: true }`. The resolver reads `listChanged === true` as the declaration.
 */
export interface ClientHandshake {
  readonly capabilities?: {
    readonly roots?: { readonly listChanged?: boolean | undefined } | undefined;
    /** A client declares `elicitation` with an object of any shape, such as `{}`. The record type rejects an array. */
    readonly elicitation?: Readonly<Record<string, unknown>> | undefined;
    /**
     * A client declares `tasks` with an object of any shape, such as `{}`. The record type rejects an array.
     * The declaration opts the client in to `task: { ttl }` on `tools/call`.
     */
    readonly tasks?: Readonly<Record<string, unknown>> | undefined;
    readonly [k: string]: unknown;
  } | undefined;
}

/** One cached entry from `roots/list`. Only the URI matters for path matching, so the root shape of the MCP SDK stays out. */
export interface CachedRoot {
  readonly uri: string;
}

export interface CapabilityResolver {
  has(capability: string): boolean;
  list(): readonly string[];

  /**
   * Records the initialize handshake of the client. Then {@link isRootsDeclared} shows the `roots` declaration.
   * Each call replaces the snapshot and clears the roots cache, because the cache belongs to one client session.
   */
  snapshot(handshake: ClientHandshake): void;
  /** True when the snapshot recorded `capabilities.roots.listChanged === true`. */
  isRootsDeclared(): boolean;
  /**
   * True when the snapshot recorded a `capabilities.elicitation` object.
   * Dispatch reads it to decide if a missing required parameter goes through `elicitation/create`.
   */
  isElicitationDeclared(): boolean;
  /**
   * True when the snapshot recorded a `capabilities.tasks` object.
   * Dispatch reads it to decide if `task: { ttl }` on `tools/call` runs as a task.
   * A `task` key in the arguments cannot replace the declaration.
   */
  isTaskSupportDeclared(): boolean;
  /**
   * Returns the cached roots list, or `undefined` when the cache is cold.
   * On a cold cache, workspace discovery fetches `roots/list` and fills the cache.
   */
  getCachedRoots(): readonly CachedRoot[] | undefined;
  /** Fills the cache with a `roots/list` result. The resolver keeps its own copy of the input. */
  setCachedRoots(roots: readonly CachedRoot[]): void;
  /** Clears the cached roots list. The `roots/list_changed` notification handler calls this, so the next read fetches again. */
  invalidateRootsCache(): void;
}

export const CAPABILITY_RESOLVER_ID = 'exarchos-capability-resolver' as const;
export const CAPABILITY_RESOLVER_VERSION = '1' as const;

export interface CapabilityAuthorization {
  readonly posture: AgentPosture;
  readonly capabilities: readonly Capability[];
}

/**
 * Returns an immutable authorization snapshot from the effective capability set of the resolver.
 * Unknown capabilities are left out. Incomplete or absent authority fails closed to read-only.
 * The function never widens the resolver result.
 */
export function resolveCapabilityAuthorization(
  resolver: CapabilityResolver | undefined,
): CapabilityAuthorization {
  const capabilities = (resolver?.list() ?? [])
    .filter((value): value is Capability => CapabilitySchema.safeParse(value).success)
    .sort();
  const frozenCapabilities = Object.freeze([...capabilities]);

  const includesPosture = (candidate: AgentPosture): boolean =>
    [...capabilitiesForPosture(candidate)].every((capability) =>
      frozenCapabilities.includes(capability));

  let posture: AgentPosture = 'read-only';
  if (includesPosture('task-isolated')) {
    posture = 'task-isolated';
  } else if (
    !frozenCapabilities.includes('isolation:worktree')
    && includesPosture('shared-mutating')
  ) {
    posture = 'shared-mutating';
  }

  return Object.freeze({ posture, capabilities: frozenCapabilities });
}

/**
 * The trust tier of the local operator, the trusted CLI caller, when no capability resolver exists.
 * The identity comes only from the state directory of the adapter, so a remote caller cannot forge it.
 * Thus this tier is an identity-layer grant, not a caller self-assertion.
 * A local operator mutates shared state without worktree isolation.
 * `shared-mutating` is the minimal tier that gives cancellation and other privileged handlers a non-empty authorization snapshot.
 */
export const LOCAL_OPERATOR_POSTURE: AgentPosture = 'shared-mutating';

/**
 * The capabilities that the local process holds beyond its posture tier.
 * The process is the Exarchos tool surface, and it is the host that spawns agents for the `agent-spawn` obligation.
 * The posture table is for agents, so a wider `shared-mutating` tier widens every agent. Thus these grants are listed here.
 * Many contracts need them, such as gate checks, the task lifecycle and `prepare_delegation`.
 */
const PROCESS_HELD_CAPABILITIES: readonly Capability[] = ['mcp:exarchos', 'subagent:spawn'];

/**
 * The full grant of the local operator: its posture tier plus the process-held capabilities.
 * The resolver path and the fallback both read it, so they agree.
 */
export function localOperatorCapabilities(): readonly Capability[] {
  const capabilities = new Set<Capability>(capabilitiesForPosture(LOCAL_OPERATOR_POSTURE));
  for (const capability of PROCESS_HELD_CAPABILITIES) capabilities.add(capability);
  return Object.freeze([...capabilities].sort());
}

export function localOperatorAuthorization(): CapabilityAuthorization {
  return Object.freeze({
    posture: LOCAL_OPERATOR_POSTURE,
    capabilities: localOperatorCapabilities(),
  });
}

export function createInMemoryResolver(
  capabilities: Iterable<string>,
): CapabilityResolver {
  const set = new Set(capabilities);
  let clientRootsDeclared = false;
  let clientElicitationDeclared = false;
  let clientTaskSupportDeclared = false;
  let cachedRoots: readonly CachedRoot[] | undefined;
  return {
    has(capability) {
      return set.has(capability);
    },
    list() {
      return [...set];
    },
    snapshot(handshake) {
      clientRootsDeclared = handshake.capabilities?.roots?.listChanged === true;
      cachedRoots = undefined;
      const elicitation = handshake.capabilities?.elicitation;
      clientElicitationDeclared =
        elicitation !== undefined
        && elicitation !== null
        && typeof elicitation === 'object'
        && !Array.isArray(elicitation);
      const tasks = handshake.capabilities?.tasks;
      clientTaskSupportDeclared =
        tasks !== undefined
        && tasks !== null
        && typeof tasks === 'object'
        && !Array.isArray(tasks);
    },
    isRootsDeclared() {
      return clientRootsDeclared;
    },
    isElicitationDeclared() {
      return clientElicitationDeclared;
    },
    isTaskSupportDeclared() {
      return clientTaskSupportDeclared;
    },
    getCachedRoots() {
      return cachedRoots;
    },
    setCachedRoots(roots) {
      cachedRoots = roots.map((r) => ({ uri: r.uri }));
    },
    invalidateRootsCache() {
      cachedRoots = undefined;
    },
  };
}

export const ANTHROPIC_NATIVE_CACHING = 'anthropic_native_caching' as const;

/**
 * Returns the capabilities that the local process holds. The CLI and the MCP server run on the machine that they govern.
 * Handshake hints are not the need set of an action.
 * The list keeps `anthropic_native_caching` for envelope consumers, unless `EXARCHOS_DISABLE_CACHE_HINTS` is `1`.
 */
export function defaultProcessCapabilityIds(): readonly string[] {
  const capabilities: string[] = [...localOperatorCapabilities()];
  if (process.env.EXARCHOS_DISABLE_CACHE_HINTS !== '1') {
    capabilities.push(ANTHROPIC_NATIVE_CACHING);
  }
  return Object.freeze(capabilities);
}

/**
 * Returns whether a held capability set satisfies one declared need.
 * The full `mcp:exarchos` tier also satisfies a `mcp:exarchos:readonly` need.
 */
export function capabilityNeedSatisfied(
  held: ReadonlySet<string>,
  needed: string,
): boolean {
  if (held.has(needed)) return true;
  return needed === 'mcp:exarchos:readonly' && held.has('mcp:exarchos');
}

export function buildDefaultProcessResolver(): CapabilityResolver {
  return createInMemoryResolver(defaultProcessCapabilityIds());
}

/**
 * The output-token cap of one turn.
 * The `output_tokens_high` quality hint fires when `outputTokens` exceeds `cap * outputTokenThreshold`.
 */
export const OUTPUT_TOKENS_PER_TURN_CAP = 32000;

/**
 * Default threshold fraction (`0.8` = 80% of `OUTPUT_TOKENS_PER_TURN_CAP`).
 * Overridden by `.exarchos.yml` → `qualityHints.outputTokenThreshold`.
 */
export const DEFAULT_OUTPUT_TOKEN_THRESHOLD_FRACTION = 0.8;

/**
 * The part of `.exarchos.yml` that {@link getQualityHintThreshold} reads.
 * The structural type avoids an import cycle with the config schema.
 */
export interface QualityHintsConfig {
  readonly qualityHints?: {
    readonly outputTokenThreshold?: number;
  };
}

/**
 * Returns the token threshold of a quality hint: the cap times the configured or default fraction.
 * Only `'output_tokens'` exists. An unknown name gets the same product, so a caller never gets `NaN`.
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
  return OUTPUT_TOKENS_PER_TURN_CAP * fraction;
}

/** The tiered `mcp:exarchos` family. One tier wins, so an agent never holds the full and the readonly tier together. */
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
 * Merges the YAML capabilities with the handshake capabilities. The handshake is the authority.
 * For the `mcp:exarchos` family, the handshake tier wins over the YAML tier, also when it is narrower.
 * Thus a stale YAML default cannot widen trust at runtime. Other families merge by union.
 *
 * A source that declares two `mcp:exarchos` tiers throws, because a pick by array order can grant too much.
 * The returned set is frozen.
 */
export function resolveEffectiveCapabilities(
  yamlCaps: readonly Capability[],
  handshakeCaps: readonly Capability[],
): ReadonlySet<Capability> {
  const effective = new Set<Capability>();

  for (const c of yamlCaps) {
    if (!isMcpExarchosFamily(c)) effective.add(c);
  }
  for (const c of handshakeCaps) {
    if (!isMcpExarchosFamily(c)) effective.add(c);
  }

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
  const soleMcpTier = handshakeMcpTiers.length === 1 ? handshakeMcpTiers[0] : yamlMcpTiers.length === 1 ? yamlMcpTiers[0] : undefined;
  if (soleMcpTier !== undefined) {
    effective.add(soleMcpTier);
  }

  return freezeSet(effective);
}

/** The posture part of an AgentSpec. `resolvePosture` reads only `posture`. */
export interface PostureSpec {
  readonly posture?: AgentPosture;
}

/**
 * The runtime handshake input of `resolvePosture`. Its declarations override the posture capabilities.
 * `capabilities` is the older flat list and acts as `allow`. `allow` grants, and `deny` revokes.
 * A downstream consumer reads this shape, so keep it stable.
 */
export interface RuntimeHandshake {
  readonly capabilities?: readonly Capability[];
  readonly allow?: readonly Capability[];
  readonly deny?: readonly Capability[];
}

/** The frozen capability set from `yaml ⊕ handshake` resolution. A downstream consumer reads this shape, so keep it stable. */
export type EffectiveCapabilities = ReadonlySet<Capability>;

/**
 * Resolves the posture of a spec to a capability set, and then applies the runtime handshake.
 * It starts from the posture capabilities, adds `capabilities` and `allow`, and removes `deny` last.
 * Thus a handshake deny revokes a posture grant. Without a posture, the set holds only the handshake grants.
 * The returned set is frozen.
 */
export function resolvePosture(
  spec: PostureSpec,
  handshake: RuntimeHandshake,
): EffectiveCapabilities {
  const effective = new Set<Capability>();

  if (spec.posture !== undefined) {
    for (const c of capabilitiesForPosture(spec.posture)) {
      effective.add(c);
    }
  }

  if (handshake.capabilities !== undefined) {
    for (const c of handshake.capabilities) effective.add(c);
  }
  if (handshake.allow !== undefined) {
    for (const c of handshake.allow) effective.add(c);
  }

  if (handshake.deny !== undefined) {
    for (const c of handshake.deny) effective.delete(c);
  }

  return freezeSet(effective);
}

/**
 * Returns a frozen Set whose mutators throw.
 * `Object.freeze` alone does not stop `.add`, because the internal slots of a Set ignore the frozen flag.
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

/** Postures whose trust tier grants mutation (fs:write). */
export type MutatingPosture = Exclude<AgentPosture, 'read-only'>;

/**
 * A capability bundle tagged by the posture it was minted from. The `posture`
 * discriminant lets a consumer's signature demand a mutating bundle and have
 * the type system reject a read-only one.
 */
export interface CapabilityBundle<P extends AgentPosture = AgentPosture> {
  readonly posture: P;
  readonly capabilities: EffectiveCapabilities;
}

/**
 * Mints the least-privilege capability bundle of a phase kind from `KIND_OBLIGATIONS[kind].posture`.
 * The phantom type is the exact posture literal of the kind, so a read-only bundle cannot reach a mutating consumer.
 * The read-only posture grants no `fs:write`.
 * The capabilities come from `resolvePosture`, so a handshake `deny` still wins.
 */
export function mintCapabilitiesForKind<K extends PhaseKind>(
  kind: K,
  handshake: RuntimeHandshake = {},
): CapabilityBundle<(typeof KIND_OBLIGATIONS)[K]['posture']> {
  const posture = KIND_OBLIGATIONS[kind].posture;
  return {
    posture,
    capabilities: resolvePosture({ posture }, handshake),
  };
}

/**
 * Returns the capabilities of a bundle that must grant mutation.
 * A read-only bundle, such as REVIEW, PLAN or GATHER, is a compile error.
 */
export function requireMutationCapabilities(
  bundle: CapabilityBundle<MutatingPosture>,
): EffectiveCapabilities {
  return bundle.capabilities;
}

/**
 * `Expect<T>` is a compile error unless `T` is `true`.
 * The checks below live in a source file, because the tsconfig excludes `*.test.ts` from the typecheck.
 */
type Expect<T extends true> = T;
type IsNotAssignable<A, B> = A extends B ? false : true;

/**
 * REVIEW (read-only) bundles must NOT satisfy a mutating consumer.
 * @proof
 */
export type _PolaReviewBundleNotMutating = Expect<
  IsNotAssignable<
    CapabilityBundle<(typeof KIND_OBLIGATIONS)['REVIEW']['posture']>,
    CapabilityBundle<MutatingPosture>
  >
>;
/**
 * PLAN (read-only) bundles must NOT satisfy a mutating consumer.
 * @proof
 */
export type _PolaPlanBundleNotMutating = Expect<
  IsNotAssignable<
    CapabilityBundle<(typeof KIND_OBLIGATIONS)['PLAN']['posture']>,
    CapabilityBundle<MutatingPosture>
  >
>;
/**
 * IMPLEMENT (task-isolated) bundles MUST satisfy a mutating consumer.
 * @proof
 */
export type _PolaImplementBundleMutating = Expect<
  CapabilityBundle<(typeof KIND_OBLIGATIONS)['IMPLEMENT']['posture']> extends CapabilityBundle<MutatingPosture>
    ? true
    : false
>;
