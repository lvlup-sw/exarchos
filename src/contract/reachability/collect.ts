// ─── Reachability inputs collector (P05-05) ──────────────────────────────────
//
// PROGRAM-05, the closure capstone (CTR-013). The impure adapter that assembles
// the pure {@link ReachabilityInputs} from the LIVE upstream authorities — one
// materialized projection per hop, so the closure model in `graph.ts` runs over
// the real tree, not a hand-maintained mirror.
//
// ── The INDEPENDENCE rule (why this file was rewritten) ──────────────────────
// The closure DENOMINATOR (`actions`) comes from `compile(deriveMetaModel())`.
// A hop materialized by re-deriving something from THAT SAME compile output is
// a TAUTOLOGY: it resolves to exactly one for every action by construction, can
// never surface a break, and inflates the headline census with evidence it does
// not have. Four hops used to be built that way:
//
//   • `route`    ← `generateRegistration(contract.descriptors)`  (1 per descriptor)
//   • `schema`   ← `contract.schemas.actions[actionId]`          (always present)
//   • `output`   ← the descriptor's own `outputKinds`/`errorCodes` (never empty)
//   • `artifact` ← `contract.proofFixtures.actions`              (1 per descriptor)
//
// Every hop is now resolved against an authority that is INDEPENDENT of that
// compile pass, and `HOP_AUTHORITIES` in `graph.ts` records which class of
// authority each hop consumes (asserted by the co-located tests, so no hop can
// silently regress to self-derivation):
//
//   • route    ← the SHIPPED composite routers' real action-level dispatch
//                tables (`dispatch-routes.ts`) — the code that actually runs.
//   • handler  ← `BINDING_TABLE` ← `dispatch/core/dispatch.ts::COMPOSITE_HANDLER_LOADERS`.
//   • owner    ← the P04-01 effect ledger via the governed provider map.
//   • schema   ← the CHECKED-IN `proof-fixtures.json`: the shipped input/output
//                schema digests must equal the live compile's.
//   • output   ← the CHECKED-IN `proof-fixtures.json`: the shipped error-family
//                + output-kind contract must be non-empty AND equal the live one.
//   • artifact ← the CHECKED-IN `cli-surface.json`: the shipped client artifact
//                exposes exactly one command for the ActionId.
//   • fixture  ← the CHECKED-IN `proof-fixtures.json`: the packaged proof.
//
// It fails LOUD (throws) when an authority is itself broken — a blocked contract
// compile, a stale effect-provider map, an unreadable router, a malformed
// shipped artifact — rather than emitting a graph that silently mis-reports a
// break. The `authored workflow` origin is the ActionId itself; binding
// ActionIds to shared-IR built-in workflows is the P07-02 seam, intentionally
// left as a pluggable origin attribute (not read here).
// ────────────────────────────────────────────────────────────────────────────

import { deriveMetaModel } from '../compiler/meta-model.js';
import { compile, type CompiledContract } from '../compiler/compile.js';
import { PROOF_FIXTURES_FILE } from '../compiler/generate.js';
import { CLI_SURFACE_FILE } from '../cli/cli-contract-seam.js';
import { digestText } from '../authority-digest.js';
import { canonicalJson } from '../request-context.js';
import { BINDING_TABLE, type ImplementationBinding } from '../bindings/binding-table.js';
import { EFFECT_OWNERSHIP, type EffectOwnershipRule } from '../../architecture/effect-ledger.js';
import { EFFECT_PROVIDERS, assertValidProviders, type EffectProvider } from './providers.js';
import {
  collectDispatchRoutes,
  resolveRouterSources,
  type DispatchRoute,
  type RouterSource,
} from './dispatch-routes.js';
import {
  readShippedCliCommands,
  readShippedProofFixtures,
  type ShippedActionFixture,
} from './shipped-artifacts.js';
import type {
  ActionNode,
  ArtifactEntry,
  ClosureException,
  FixtureEntry,
  OutputEntry,
  OwnerEntry,
  ReachabilityInputs,
  RouteEntry,
  SchemaEntry,
} from './graph.js';

/**
 * The governed closure-exception list. An entry is added only with a conscious,
 * reviewed reason for a genuinely-unclosed action — and a stale entry (an
 * action that is actually closed) is itself flagged by `evaluateClosure` (the
 * two-way ratchet). Kept here, beside the collector, so the governed
 * exceptions travel with the live wiring.
 *
 * CURRENTLY EMPTY: the #1739 cutover-verb entries were removed when the
 * regenerated CLI-surface golden picked the two actions up (122-action
 * surface) — exactly the removal the two-way ratchet forces on a stale entry.
 */
export const LIVE_CLOSURE_EXCEPTIONS: readonly ClosureException[] = Object.freeze([]);

/**
 * Overridable inputs so a test can target another tree / snapshot.
 *
 * Each option names a REAL authority, not a materialized hop projection: a kill
 * fixture points these at a MUTATED COPY of the real input (a router source with
 * a renamed case arm, a dispatch loader map with an entry removed, a tampered
 * shipped artifact) and the census must drop. There is deliberately no option to
 * hand-author `ReachabilityInputs` directly — that would prove only that the
 * evaluator works, which is the exact gap this collector's proof used to have.
 */
export interface CollectOptions {
  readonly compiled?: CompiledContract;
  readonly providers?: readonly EffectProvider[];
  readonly rules?: readonly EffectOwnershipRule[];
  readonly bindings?: readonly ImplementationBinding[];
  /** The composite router modules whose real dispatch tables supply the `route` hop. */
  readonly routerSources?: readonly RouterSource[];
  /** Path to the checked-in packaged proof-fixture baseline. */
  readonly fixturesFile?: string;
  /** Path to the checked-in shipped CLI-surface artifact. */
  readonly cliSurfaceFile?: string;
  readonly exceptions?: readonly ClosureException[];
}

/** Compile the live contract or throw a readable aggregated diagnostic. */
function compileLive(): CompiledContract {
  const outcome = compile(deriveMetaModel());
  if (!outcome.ok) {
    const summary = outcome.diagnostics
      .map((d) => `  [${d.code}] ${d.actionId} ${d.path}: ${d.message}`)
      .join('\n');
    throw new Error(
      `reachability: contract compilation BLOCKED — ${outcome.diagnostics.length} diagnostic(s):\n${summary}`,
    );
  }
  return outcome.output;
}

/** The packaged-proof ActionId set — read from the checked-in fixture baseline. */
export function readPackagedFixtureActionIds(
  fixturesFile: string = PROOF_FIXTURES_FILE,
): readonly string[] {
  return readShippedProofFixtures(fixturesFile).map((a) => a.actionId);
}

/** Materialize the owner projection from the (validated) effect-provider map. */
function collectOwners(
  providers: readonly EffectProvider[],
  rules: readonly EffectOwnershipRule[],
): readonly OwnerEntry[] {
  // Throws on a stale/duplicate provider — fail loud, never mis-report an owner.
  const valid = assertValidProviders(providers, rules);
  return valid.map((p): OwnerEntry => ({ tool: p.tool, owner: p.owner }));
}

/** Ordered equality for the string lists the shipped baseline records. */
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * Assemble the live {@link ReachabilityInputs}. Deterministic and side-effect
 * free apart from reading the shipped generated artifacts + the composite router
 * sources. Every projection is derived from a real authority, and NO hop is
 * re-derived from the same `compile()` pass that supplies the denominator.
 */
export function collectReachabilityInputs(opts: CollectOptions = {}): ReachabilityInputs {
  const contract = opts.compiled ?? compileLive();
  const providers = opts.providers ?? EFFECT_PROVIDERS;
  const rules = opts.rules ?? EFFECT_OWNERSHIP;
  const bindings = opts.bindings ?? BINDING_TABLE;
  const fixturesFile = opts.fixturesFile ?? PROOF_FIXTURES_FILE;
  const cliSurfaceFile = opts.cliSurfaceFile ?? CLI_SURFACE_FILE;
  const routerSources = opts.routerSources ?? resolveRouterSources(providers);

  const actions: ActionNode[] = contract.descriptors.map((d) => ({
    actionId: d.actionId,
    tool: d.tool,
    action: d.action,
    mutates: d.policy.effect.mutates,
  }));

  // ── route ── the SHIPPED routers' real action-level dispatch tables. A route
  // exists because the composite router code routes that action, NOT because a
  // descriptor declared it: an ActionId the registry declares but no router
  // serves resolves to 0 here, and a duplicated routing arm resolves to 2.
  const dispatchRoutes: readonly DispatchRoute[] = collectDispatchRoutes(routerSources);
  const routes: RouteEntry[] = dispatchRoutes.map((r) => ({ actionId: r.actionId, tool: r.tool }));

  // ── handler ── the real composite-handler loader map (via the binding table).
  const handlers = bindings.map((b) => ({ tool: b.tool }));

  // ── owner ── the P04-01 effect ledger via the governed provider map.
  const owners = collectOwners(providers, rules);

  // ── schema / output / fixture ── the CHECKED-IN proof-fixture baseline.
  const shippedFixtures: readonly ShippedActionFixture[] = readShippedProofFixtures(fixturesFile);
  const shippedByActionId = new Map<string, ShippedActionFixture[]>();
  for (const entry of shippedFixtures) {
    const bucket = shippedByActionId.get(entry.actionId);
    if (bucket) bucket.push(entry);
    else shippedByActionId.set(entry.actionId, [entry]);
  }

  const fixtures: FixtureEntry[] = shippedFixtures.map((f) => ({ actionId: f.actionId }));

  // The action's I/O schema AS SHIPPED must be the schema the live compile
  // derives — digests are compared, so a stale or hand-edited baseline breaks
  // the hop instead of being re-derived into agreement with itself.
  const schemas: SchemaEntry[] = [];
  const outputs: OutputEntry[] = [];
  for (const descriptor of contract.descriptors) {
    const pair = contract.schemas.actions[descriptor.actionId];
    for (const shipped of shippedByActionId.get(descriptor.actionId) ?? []) {
      if (
        pair !== undefined &&
        pair.input !== undefined &&
        pair.output !== undefined &&
        digestText(canonicalJson(pair.input)) === shipped.inputSchemaDigest &&
        digestText(canonicalJson(pair.output)) === shipped.outputSchemaDigest
      ) {
        schemas.push({ actionId: descriptor.actionId });
      }
      // The bound output contract AS SHIPPED. `resolveHops` additionally
      // requires both lists to be non-empty, so an emptied shipped contract is
      // a `missing output` break rather than a silently-degraded one.
      if (
        sameStrings(shipped.outputKinds, [...descriptor.outputKinds]) &&
        sameStrings(shipped.errorCodes, [...descriptor.errorCodes])
      ) {
        outputs.push({
          actionId: descriptor.actionId,
          outputKinds: [...shipped.outputKinds],
          errorCodes: [...shipped.errorCodes],
        });
      }
    }
  }

  // ── artifact ── the SHIPPED client surface (a different generation pass's
  // committed artifact): the packaged CLI exposes a command for the ActionId.
  const artifacts: ArtifactEntry[] = readShippedCliCommands(cliSurfaceFile).map((c) => ({
    actionId: c.actionId,
  }));

  return {
    surfaceVersion: contract.surfaceVersion,
    actions,
    schemas,
    routes,
    handlers,
    owners,
    outputs,
    artifacts,
    fixtures,
    exceptions: opts.exceptions ?? LIVE_CLOSURE_EXCEPTIONS,
  };
}
