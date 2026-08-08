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

import { Capability as CapabilitySchema, type Capability } from '../agents/capabilities.js';
import type { AgentPosture } from '../agents/spec.js';
import type { ToolResult } from '../format.js';
import { capabilitiesForPosture } from './posture-mapping.js';
import { KIND_OBLIGATIONS } from '../workflow/phase-kind.js';
import type { PhaseKind } from '../workflow/phase-kind.js';

/**
 * Minimal slice of the MCP initialize handshake consumed by
 * {@link CapabilityResolver.snapshot}. The full handshake carries more
 * fields (protocol version, client info, etc.) — we accept a structural
 * shape so callers can pass the raw handshake without import gymnastics.
 *
 * Per the MCP spec, the `roots` capability is signaled by the client as
 * `capabilities.roots: { listChanged: true }` when it both supports the
 * `roots/list` request and will emit `notifications/roots/list_changed`
 * on root-set mutations. The resolver treats `listChanged === true` as
 * the authoritative declaration (#1290).
 */
export interface ClientHandshake {
  readonly capabilities?: {
    readonly roots?: { readonly listChanged?: boolean | undefined } | undefined;
    /**
     * Per the MCP spec (#1274), the `elicitation` capability is signaled by
     * the client as `capabilities.elicitation: {}` — the presence of the
     * object (any shape, including the empty object) is the declaration
     * the resolver treats as authoritative. CodeRabbit MINOR #1424:
     * narrowed from `object` to `Record<string, unknown>` so the type
     * itself rejects array handshakes (`object` admits arrays in TS).
     */
    readonly elicitation?: Readonly<Record<string, unknown>> | undefined;
    /**
     * Per the MCP spec (#1273), the `tasks` capability is signaled by the
     * client as `capabilities.tasks: { ... }` — the presence of the object
     * (any shape, including the empty object) is the declaration the
     * resolver treats as authoritative. Fine-grain method support
     * (`list` / `cancel` / per-request augmentation) rides inside the
     * object but is not load-bearing for the gate: a client that
     * declares `tasks: {}` is opting in to the request-augmentation
     * surface (`task: { ttl }` on `tools/call`) at minimum.
     *
     * CodeRabbit MINOR #1424 (applied here too): narrowed from `object` to
     * `Readonly<Record<string, unknown>>` so the type itself rejects array
     * handshakes — `typeof [] === 'object'` so the looser type would admit
     * a malformed array declaration.
     */
    readonly tasks?: Readonly<Record<string, unknown>> | undefined;
    readonly [k: string]: unknown;
  } | undefined;
}

/**
 * Cached entry from `roots/list`. Kept structurally minimal (`uri`) so
 * downstream workspace discovery doesn't pull the MCP SDK Roots shape
 * transitively. Tests can construct fixtures without spinning up a
 * transport. The MCP spec carries an optional `name` field on each root
 * which we ignore — only the URI is load-bearing for path matching.
 */
export interface CachedRoot {
  readonly uri: string;
}

export interface CapabilityResolver {
  has(capability: string): boolean;
  list(): readonly string[];

  // ─── #1290 Roots capability snapshot ──────────────────────────────────
  /**
   * Snapshot the client's initialize handshake. After this call,
   * {@link isRootsDeclared} reflects whether the client supports the
   * `roots` capability. Calling snapshot a second time replaces the
   * prior snapshot wholesale — the latest handshake wins.
   */
  snapshot(handshake: ClientHandshake): void;
  /** True when the snapshot recorded `capabilities.roots.listChanged === true`. */
  isRootsDeclared(): boolean;
  /**
   * True when the snapshot recorded a `capabilities.elicitation` object
   * (any shape — presence is the gate, per MCP spec #1274). Consumed by
   * dispatch to decide whether missing-required-param paths route through
   * `elicitation/create` or fall back to INVALID_INPUT.
   */
  isElicitationDeclared(): boolean;
  /**
   * True when the snapshot recorded a `capabilities.tasks` object (any
   * shape — presence is the gate, per MCP spec #1273). Consumed by
   * the dispatch-core's task-augmented branch to decide whether
   * `task: { ttl }` on `tools/call` synthesises a `CreateTaskResult`
   * or is gracefully ignored in favour of the legacy one-shot envelope.
   *
   * Defence-in-depth: a client that never advertised tasks support
   * cannot opt in by smuggling a `task` key into args — capability
   * negotiation is the authoritative gate.
   */
  isTaskSupportDeclared(): boolean;
  /**
   * Return the cached roots list, or `undefined` when the cache is cold
   * (either never populated or freshly invalidated via
   * {@link invalidateRootsCache}). Synchronous: workspace discovery is
   * expected to populate the cache lazily before calling.
   */
  getCachedRoots(): readonly CachedRoot[] | undefined;
  /**
   * Populate the cache with the result of a `roots/list` call. The
   * resolver stores its own copy so downstream mutations of the input
   * array don't desync the cache.
   */
  setCachedRoots(roots: readonly CachedRoot[]): void;
  /**
   * Drop the cached roots list. Wired to the MCP `roots/list_changed`
   * notification handler — the next call to {@link getCachedRoots}
   * returns `undefined` and forces a refetch.
   */
  invalidateRootsCache(): void;
}

export const CAPABILITY_RESOLVER_ID = 'exarchos-capability-resolver' as const;
export const CAPABILITY_RESOLVER_VERSION = '1' as const;

export interface CapabilityAuthorization {
  readonly posture: AgentPosture;
  readonly capabilities: readonly Capability[];
}

/**
 * Read an immutable authorization snapshot from the resolver's effective
 * capability set. Unknown feature-hint capabilities are excluded from the
 * authorization record. Incomplete or absent authority resolves fail-closed
 * to read-only; this function never widens or re-merges the resolver result.
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
 * Trust tier granted to a machine-owner local-operator caller (the CLI
 * trusted-caller path) when the wiring supplies no runtime capability
 * resolver.
 *
 * The `local-operator` identity is derived exclusively from the adapter-owned
 * state directory (see `deriveLocalOperatorIdentity`) — never from
 * caller-supplied input — so it cannot be forged by a remote/untrusted caller.
 * Minting its baseline capabilities here is therefore an identity-layer GRANT,
 * not a caller self-assertion (P01-07): the operator never names its own
 * capabilities. `shared-mutating` is the correct tier — a local operator
 * mutates shared state (the event log, the repository) with no worktree
 * isolation — and it is the minimal set that lets privileged lifecycle
 * handlers (notably cancellation) record a non-empty, schema-valid
 * authorization snapshot (`AuthorizationSnapshotV1Schema.capabilityIds.min(1)`).
 */
export const LOCAL_OPERATOR_POSTURE: AgentPosture = 'shared-mutating';

export function localOperatorAuthorization(): CapabilityAuthorization {
  const capabilities = Object.freeze(
    [...capabilitiesForPosture(LOCAL_OPERATOR_POSTURE)].sort(),
  );
  return Object.freeze({ posture: LOCAL_OPERATOR_POSTURE, capabilities });
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
      // CodeRabbit MAJOR #1423: roots/list cache is handshake-scoped — any
      // cached roots from a prior handshake belong to a different client
      // session and must not carry over. Clearing here forces the first
      // `getCachedRoots()` after a new handshake to return `undefined`, so
      // the workspace resolver re-fetches via the new client's roots/list.
      cachedRoots = undefined;
      // #1274 — `capabilities.elicitation` is presence-gated: the spec
      // says `{}` is a valid declaration, so we record true whenever the
      // field is a non-null object regardless of shape. CodeRabbit MINOR
      // #1424: explicitly reject arrays — `typeof [] === 'object'` so the
      // pre-fix check would have admitted a malformed array handshake.
      const elicitation = handshake.capabilities?.elicitation;
      clientElicitationDeclared =
        elicitation !== undefined
        && elicitation !== null
        && typeof elicitation === 'object'
        && !Array.isArray(elicitation);
      // #1273 — `capabilities.tasks` follows the same presence-gated
      // rule as elicitation. The fine-grain method shape rides inside
      // the object; declaring it at all opts the client in to the
      // request-augmentation surface (`task: { ttl }` on `tools/call`).
      // CodeRabbit MINOR #1424 (carried over): explicitly reject arrays —
      // `typeof [] === 'object'` so the pre-fix check would have admitted
      // a malformed array handshake.
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
  const soleMcpTier = handshakeMcpTiers.length === 1 ? handshakeMcpTiers[0] : yamlMcpTiers.length === 1 ? yamlMcpTiers[0] : undefined;
  if (soleMcpTier !== undefined) {
    effective.add(soleMcpTier);
  }

  return freezeSet(effective);
}

// ─── INV-11: the shared-mutating posture gate was DELETED ──────────────────
//
// `enforceSharedMutatingGate` lived here and rejected a `shared-mutating`
// action whose caller declared `isolation:worktree` or lacked `fs:write`.
// It is gone, not relaxed. The rationale is recorded at its former call site
// in `core/dispatch.ts`; in short: `task-isolated` holds a strict SUPERSET of
// `shared-mutating`'s capabilities, so the gate was never an authority
// ordering — it read `isolation:worktree` as a location marker. INV-11
// forbids inferring confinement from worktree ownership, and the capability
// was self-declared, so the gate bounded nothing while pushing operators to
// do the same merge by hand, unaudited.
//
// `enforceReadonlyGate` (core/dispatch.ts) is untouched: STATE authority IS
// dispatch-owned under INV-11, and read-only callers are still rejected for
// these verbs because they are absent from READ_ONLY_ACTIONS.

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

// ─── DR-14 / INV-11: POLA capability bundle from a phase kind's posture ─────
//
// The central enforcement point the resolver map lacked: a capability bundle
// minted from `KIND_OBLIGATIONS[kind].posture` through the existing
// `resolvePosture` machinery (compose, do not duplicate; the handshake stays
// authoritative). The phantom `posture` type makes worktree mutation from a
// read-only phase kind UNREPRESENTABLE — a REVIEW/PLAN/GATHER bundle is not
// assignable where a mutating bundle is required (compile-time), and carries no
// `fs:write` token at runtime.

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
 * Mint the POLA capability bundle for a phase kind. The posture is statically
 * known per kind (`KIND_OBLIGATIONS` is `as const`), so the returned bundle's
 * phantom type is the kind's exact posture literal. Capabilities resolve through
 * `resolvePosture`, so the runtime handshake stays authoritative (a `deny`
 * revokes a posture grant).
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
 * Consume a capability bundle that MUST carry mutation access. Passing a
 * read-only (REVIEW/PLAN/GATHER) bundle is a COMPILE error — the structural
 * half of DR-14's "worktree mutation is unrepresentable from a read-only phase".
 */
export function requireMutationCapabilities(
  bundle: CapabilityBundle<MutatingPosture>,
): EffectiveCapabilities {
  return bundle.capabilities;
}

// ─── Compile-time POLA guarantees (verified by `npm run typecheck`) ─────────
// These exported type aliases live in a non-test source file, so the build's
// `tsc` (the static-analysis gate) actively verifies them — the project's
// tsconfig excludes *.test.ts, so a `@ts-expect-error` in a test would NOT be
// gate-enforced. `Expect<T extends true>` is a compile error unless T is `true`.
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
