/**
 * Capability resolver (T017, DR-14; live posture handshake per DR-8 #1688)
 *
 * Runtime capability detection for MCP callers. The initialize handshake is
 * snapshotted into this resolver: protocol capabilities (roots / elicitation
 * / tasks) become booleans, and the namespaced caller-posture declaration
 * (`capabilities.experimental['exarchos/posture']`) resolves a live trust
 * tier per INV-11 — handshake-authoritative merge with the agent-spec
 * posture, defaulting to read-only when neither half declares.
 *
 * Consumers should depend on the {@link CapabilityResolver} interface rather
 * than the concrete factory so that the resolver can be swapped for an
 * alternative implementation.
 */

import type { Capability } from '../agents/capabilities.js';
import type { AgentPosture } from '../agents/spec.js';
import type { ToolResult } from '../format.js';
import { capabilitiesForPosture, listPostures } from './posture-mapping.js';
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
    /**
     * DR-8 (#1688) — the MCP spec's designated channel for non-standard
     * client capabilities. Exarchos reads ONE namespaced key from it:
     * `experimental['exarchos/posture'] = { posture: <AgentPosture> }`
     * (see {@link POSTURE_HANDSHAKE_KEY}). This is the runtime half of
     * INV-11's `agent-spec ⊕ handshake` posture merge.
     */
    readonly experimental?: Readonly<Record<string, unknown>> | undefined;
    readonly [k: string]: unknown;
  } | undefined;
}

// ─── DR-8 / INV-11: caller-posture handshake declaration (#1688) ───────────

/**
 * The namespaced `capabilities.experimental` key a live MCP caller uses to
 * declare its trust posture during the initialize handshake:
 *
 * ```jsonc
 * // Client → initialize request
 * { "capabilities": { "experimental": {
 *     "exarchos/posture": { "posture": "shared-mutating" } } } }
 * ```
 *
 * `experimental` is the MCP spec's escape hatch for capabilities the protocol
 * does not model natively — clients that do not understand the key simply
 * omit it and resolve to the default read-only tier, so the channel is
 * backwards-compatible by construction.
 */
export const POSTURE_HANDSHAKE_KEY = 'exarchos/posture' as const;

/**
 * The INV-5b diagnosability record for a posture resolution: which posture
 * became effective, WHY (source), and what each half of the INV-11 merge
 * declared. Queryable via {@link CapabilityResolver.getPostureResolution},
 * logged by the MCP adapter after every initialize snapshot, and stamped
 * onto CAPABILITY_DENIED envelopes (`_meta.postureResolution`) by
 * {@link enforceSharedMutatingGate} so a denied caller can see exactly what
 * tier the server derived for it.
 */
export interface PostureResolution {
  /** The posture whose trust tier is in force for this session. */
  readonly effectivePosture: AgentPosture;
  /**
   * Which half of INV-11's merge won: `handshake` (a valid live declaration
   * — always authoritative), `agent-spec` (the spec's yaml posture, used
   * only when the handshake is silent), or `default` (neither declared —
   * the read-only fail-closed tier).
   */
  readonly source: 'handshake' | 'agent-spec' | 'default';
  /** The posture the handshake validly declared, when it did. */
  readonly handshakePosture?: AgentPosture;
  /** The agent-spec posture the resolver was constructed with, when set. */
  readonly specPosture?: AgentPosture;
  /**
   * True when the handshake carried a `POSTURE_HANDSHAKE_KEY` entry that was
   * malformed (wrong shape or an unknown posture string). Malformed
   * declarations are IGNORED — fail closed to spec/default — but flagged
   * here so a misconfigured client is diagnosable rather than silent.
   */
  readonly invalidHandshakeDeclaration?: boolean;
  /**
   * The trust-tier capabilities minted from `effectivePosture` and folded
   * into the live resolver set. Empty for `source: 'default'` — see
   * {@link createInMemoryResolver} for why the default tier enforces by
   * ABSENCE rather than by minting the read-only capability set.
   */
  readonly mintedCapabilities: readonly Capability[];
}

/**
 * Union of every capability that appears in ANY posture's trust tier
 * (`POSTURE_CAPABILITY_MAP`). When a posture has been resolved from a live
 * declaration, membership questions about THESE capabilities are answered
 * exclusively by the posture-derived tier (tier REPLACEMENT — INV-11
 * handshake-authoritative), while non-tier capabilities (cache hints,
 * per-agent overlays) keep answering from the constructor seed.
 */
const TRUST_TIER_CAPABILITIES: ReadonlySet<Capability> = (() => {
  const union = new Set<Capability>();
  for (const posture of listPostures()) {
    for (const cap of capabilitiesForPosture(posture)) union.add(cap);
  }
  return union;
})();

/** Type guard: is `value` one of the three canonical postures? */
function isAgentPosture(value: unknown): value is AgentPosture {
  return (
    typeof value === 'string'
    && (listPostures() as readonly string[]).includes(value)
  );
}

/**
 * Outcome of reading the posture declaration out of an initialize handshake.
 * `declared` is the valid posture when one was present; `invalid` marks a
 * present-but-malformed declaration (ignored, fail closed).
 */
interface HandshakePostureExtraction {
  readonly declared: AgentPosture | undefined;
  readonly invalid: boolean;
}

function extractHandshakePosture(
  handshake: ClientHandshake,
): HandshakePostureExtraction {
  const experimental = handshake.capabilities?.experimental;
  if (
    experimental === undefined
    || experimental === null
    || typeof experimental !== 'object'
    || Array.isArray(experimental)
  ) {
    return { declared: undefined, invalid: false };
  }
  const entry = (experimental as Record<string, unknown>)[POSTURE_HANDSHAKE_KEY];
  if (entry === undefined) {
    return { declared: undefined, invalid: false };
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { declared: undefined, invalid: true };
  }
  const posture = (entry as Record<string, unknown>)['posture'];
  if (isAgentPosture(posture)) {
    return { declared: posture, invalid: false };
  }
  return { declared: undefined, invalid: true };
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

  // ─── DR-8 / INV-11: caller-posture handshake resolution (#1688) ───────
  /**
   * The INV-5b diagnosability record for the current posture resolution:
   * effective posture, winning source (handshake > agent-spec > default),
   * both declared halves, and the minted trust-tier capabilities. Never
   * `undefined` — before any snapshot it reflects the construction-time
   * resolution (agent-spec posture when supplied, else the read-only
   * default).
   */
  getPostureResolution(): PostureResolution;
}

/**
 * Construction options for {@link createInMemoryResolver}.
 */
export interface InMemoryResolverOptions {
  /**
   * The agent-spec posture (the yaml half of INV-11's merge). When set, its
   * trust tier is in force from construction; a live handshake declaring a
   * DIFFERENT posture replaces it wholesale (handshake-authoritative). The
   * live MCP server constructs its resolver without this — the field exists
   * for embedding contexts that dispatch on behalf of a spec'd agent.
   */
  readonly specPosture?: AgentPosture;
}

export function createInMemoryResolver(
  capabilities: Iterable<string>,
  options?: InMemoryResolverOptions,
): CapabilityResolver {
  const set = new Set(capabilities);
  const specPosture = options?.specPosture;
  let clientRootsDeclared = false;
  let clientElicitationDeclared = false;
  let clientTaskSupportDeclared = false;
  let cachedRoots: readonly CachedRoot[] | undefined;

  // ─── DR-8 / INV-11 (#1688): posture-derived trust tier ────────────────
  // `postureCaps` is the capability set minted from the effective posture,
  // or `undefined` when no posture was declared by EITHER half (the
  // legacy/default state, in which the constructor seed answers alone).
  //
  // Precedence (INV-11, handshake-authoritative): a valid handshake
  // declaration ALWAYS wins — even when narrower than the agent-spec
  // posture — because the runtime is the source of truth for what is
  // actually mounted. The merge is tier REPLACEMENT, not union: unioning a
  // task-isolated spec with a shared-mutating handshake would leak
  // `isolation:worktree` into the effective set and flip
  // `enforceSharedMutatingGate` the wrong way.
  //
  // Default (neither half declares): NOTHING is minted. The undeclared
  // caller's read-only tier is enforced by ABSENCE — no `fs:write` means
  // every `posture: 'shared-mutating'` action stays CAPABILITY_DENIED —
  // rather than by minting `capabilitiesForPosture('read-only')`, because
  // that set contains `mcp:exarchos:readonly`, which would activate the
  // `enforceReadonlyGate` allowlist and break every undeclared live
  // session's ordinary mutating actions (task_claim, workflow appends, …).
  // An EXPLICIT read-only declaration does mint the tier (opt-in).
  let postureCaps: ReadonlySet<Capability> | undefined;
  let postureResolution: PostureResolution;

  const recomputePosture = (extraction: HandshakePostureExtraction): void => {
    const invalidFlag = extraction.invalid
      ? { invalidHandshakeDeclaration: true as const }
      : {};
    if (extraction.declared !== undefined) {
      postureCaps = capabilitiesForPosture(extraction.declared);
      postureResolution = {
        effectivePosture: extraction.declared,
        source: 'handshake',
        handshakePosture: extraction.declared,
        ...(specPosture !== undefined ? { specPosture } : {}),
        mintedCapabilities: [...postureCaps],
      };
    } else if (specPosture !== undefined) {
      postureCaps = capabilitiesForPosture(specPosture);
      postureResolution = {
        effectivePosture: specPosture,
        source: 'agent-spec',
        specPosture,
        ...invalidFlag,
        mintedCapabilities: [...postureCaps],
      };
    } else {
      postureCaps = undefined;
      postureResolution = {
        effectivePosture: 'read-only',
        source: 'default',
        ...invalidFlag,
        mintedCapabilities: [],
      };
    }
  };
  // Construction-time resolution: the agent-spec half (or default) is in
  // force until the first handshake snapshot arrives.
  recomputePosture({ declared: undefined, invalid: false });

  return {
    has(capability) {
      // Tier replacement (INV-11): once a posture is resolved, trust-tier
      // capability membership is answered EXCLUSIVELY by the minted tier —
      // a constructor-seeded trust cap must not survive a narrower live
      // declaration. Non-tier capabilities (cache hints, per-agent
      // overlays) keep answering from the seed. The cast is safe: `.has`
      // on a non-member simply returns false.
      if (
        postureCaps !== undefined
        && TRUST_TIER_CAPABILITIES.has(capability as Capability)
      ) {
        return postureCaps.has(capability as Capability);
      }
      return set.has(capability);
    },
    list() {
      if (postureCaps === undefined) return [...set];
      const merged = new Set<string>();
      for (const c of set) {
        if (!TRUST_TIER_CAPABILITIES.has(c as Capability)) merged.add(c);
      }
      for (const c of postureCaps) merged.add(c);
      return [...merged];
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
      // DR-8 / INV-11 (#1688) — derive the caller's trust posture from the
      // namespaced `experimental['exarchos/posture']` declaration and
      // recompute the effective tier. Snapshot-wholesale semantics apply
      // here too: a second handshake WITHOUT a declaration reverts the
      // session to the spec/default tier — posture-derived capabilities
      // never accumulate across handshakes.
      recomputePosture(extractHandshakePosture(handshake));
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
    getPostureResolution() {
      return postureResolution;
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

// ─── DR-4 / INV-11: shared-mutating posture gate ───────────────────────────
//
// The resolver-seam companion to `enforceReadonlyGate` (core/dispatch.ts). An
// action declaring `posture: 'shared-mutating'` (merge_orchestrate,
// serialize_merge, prune_worktrees) mutates SHARED, un-isolated state — the
// integration branch, the main working tree, the singleton `worktrees` event
// stream — from the main worktree with NO worktree isolation. Two caller tiers
// are structurally incompatible and MUST be rejected BEFORE the handler runs:
//
//   - task-isolated: carries `isolation:worktree`. Its whole contract is that
//     the worktree boundary contains its blast radius, so it cannot legally
//     mutate the shared integration ref. The readonly allowlist cannot express
//     this rejection — a task-isolated caller holds full `mcp:exarchos`, which
//     passes `enforceReadonlyGate`. This gate closes that hole.
//   - read-only: lacks `fs:write` (only `mcp:exarchos:readonly`). Cannot mutate
//     at all. `enforceReadonlyGate` already rejects it for these verbs (they are
//     absent from READ_ONLY_ACTIONS); this branch is defence-in-depth so the
//     posture gate is self-consistent even for a hypothetical shared-mutating
//     verb that WAS allowlisted.
//
// Only a shared-mutating caller ({fs:read, fs:write, shell:exec}, no
// isolation:worktree) satisfies the tier and proceeds. Rejection is a
// structured CAPABILITY_DENIED envelope carrying tool + action so the caller
// can correlate; because the gate returns before the composite handler is
// constructed/invoked, no handler runs and no event is emitted.

/**
 * The single capability that distinguishes a task-isolated caller: presence of
 * `isolation:worktree` means the caller is confined to a worktree and must not
 * mutate shared state.
 */
const WORKTREE_ISOLATION_CAPABILITY = 'isolation:worktree' as const;

/** The write capability every mutating tier holds; its absence marks read-only. */
const WRITE_CAPABILITY = 'fs:write' as const;

function sharedMutatingDenial(
  tool: string,
  action: string,
  reason: string,
  postureResolution: PostureResolution,
): ToolResult {
  return {
    success: false,
    error: {
      code: 'CAPABILITY_DENIED',
      message:
        `Action "${action}" on tool "${tool}" declares the shared-mutating trust tier: ${reason}.`,
      tool,
      action,
    },
    // DR-8 / INV-5b (#1688): the denial carries the full posture-resolution
    // record so a rejected caller can see WHAT tier the server derived for
    // it and WHY (source + both declared halves) without a server-side log
    // dig. Dispatch's `attachMeta` merges correlation IDs around this
    // non-destructively (caller-supplied `_meta` wins on conflict).
    _meta: { postureResolution },
  };
}

/**
 * Enforce the shared-mutating posture gate. Returns a structured
 * CAPABILITY_DENIED {@link ToolResult} when the caller's effective capabilities
 * are incompatible with a `shared-mutating` action, or `null` when the call may
 * proceed.
 *
 * Fires only when the action declares `posture: 'shared-mutating'` AND a
 * resolver is wired (the MCP handshake path). Direct CLI / in-process callers
 * without a resolver are not gated — parity with `enforceReadonlyGate`, which
 * treats an absent resolver as "not gated" because those callers have no
 * handshake to snapshot.
 */
export function enforceSharedMutatingGate(
  tool: string,
  action: string,
  posture: AgentPosture | undefined,
  resolver: CapabilityResolver | undefined,
): ToolResult | null {
  if (posture !== 'shared-mutating') return null;
  if (!resolver) return null;

  // task-isolated: worktree-confined caller cannot mutate the shared ref.
  if (resolver.has(WORKTREE_ISOLATION_CAPABILITY)) {
    return sharedMutatingDenial(
      tool,
      action,
      'a task-isolated (isolation:worktree) caller cannot mutate shared, un-isolated state',
      resolver.getPostureResolution(),
    );
  }

  // read-only tier / any caller lacking fs:write cannot mutate shared state.
  if (!resolver.has(WRITE_CAPABILITY)) {
    return sharedMutatingDenial(
      tool,
      action,
      'a read-only caller (no fs:write) cannot mutate shared, un-isolated state',
      resolver.getPostureResolution(),
    );
  }

  return null;
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

/** REVIEW (read-only) bundles must NOT satisfy a mutating consumer. */
export type _PolaReviewBundleNotMutating = Expect<
  IsNotAssignable<
    CapabilityBundle<(typeof KIND_OBLIGATIONS)['REVIEW']['posture']>,
    CapabilityBundle<MutatingPosture>
  >
>;
/** PLAN (read-only) bundles must NOT satisfy a mutating consumer. */
export type _PolaPlanBundleNotMutating = Expect<
  IsNotAssignable<
    CapabilityBundle<(typeof KIND_OBLIGATIONS)['PLAN']['posture']>,
    CapabilityBundle<MutatingPosture>
  >
>;
/** IMPLEMENT (task-isolated) bundles MUST satisfy a mutating consumer. */
export type _PolaImplementBundleMutating = Expect<
  CapabilityBundle<(typeof KIND_OBLIGATIONS)['IMPLEMENT']['posture']> extends CapabilityBundle<MutatingPosture>
    ? true
    : false
>;
