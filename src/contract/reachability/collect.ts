/**
 * Builds the pure {@link ReachabilityInputs} from the live authorities, so the closure model in
 * `graph.ts` runs over the real tree.
 *
 * The denominator (`actions`) comes from `compile(deriveMetaModel())`. A hop derived from that same
 * compile output resolves for each action by construction, and can never show a break. So each hop
 * reads an independent authority, and `HOP_AUTHORITIES` in `graph.ts` records which one.
 *
 * The collector throws when an authority is broken, such as a blocked compile, a stale provider
 * map, an unreadable router, or a malformed shipped artifact.
 */

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
import { EVENT_ANNOTATIONS } from '../../events/event-annotations.js';
import { TOOL_REGISTRY, contractEmissionsOf, type BuiltinCompositeTool } from '../../registry.js';
import type { EventRegistration } from '../../events/event-registration.js';
import type {
  ActionNode,
  ArtifactEntry,
  ClosureException,
  EmissionEntry,
  FixtureEntry,
  OutputEntry,
  OwnerEntry,
  ReachabilityInputs,
  RouteEntry,
  SchemaEntry,
} from './graph.js';

/**
 * The governed closure-exception list. Add an entry only with a reviewed reason for an action that
 * is not closed. `evaluateClosure` reports an entry for a closed action as a `stale-exception`.
 */
export const LIVE_CLOSURE_EXCEPTIONS: readonly ClosureException[] = Object.freeze([]);

/**
 * Overridable inputs, so a test can target another tree. Each option names a real authority, not a
 * hop projection. A kill fixture points an option at a changed copy of the real input, and the
 * census must drop. No option accepts hand-authored `ReachabilityInputs`, because that proves only
 * the evaluator.
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
  /** The event catalog the `event` / `consumer` hops resolve against. */
  readonly annotations?: Readonly<Record<string, EventRegistration>>;
  /** The tool registry supplying each action's nested contract emissions. */
  readonly registry?: readonly BuiltinCompositeTool[];
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

/**
 * Builds the owner projection from the effect-provider map. It throws on a stale or duplicate
 * provider.
 */
function collectOwners(
  providers: readonly EffectProvider[],
  rules: readonly EffectOwnershipRule[],
): readonly OwnerEntry[] {
  const valid = assertValidProviders(providers, rules);
  return valid.map((p): OwnerEntry => ({ tool: p.tool, owner: p.owner }));
}

/** Ordered equality for the string lists the shipped baseline records. */
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * Assembles the live {@link ReachabilityInputs}. It reads the shipped generated artifacts and the
 * composite router sources, and has no other side effect. The hop sources:
 * - `route`: the dispatch tables of the shipped routers. An action that no router serves gives 0.
 * - `handler` and `owner`: the binding table and the effect-provider map.
 * - `schema`, `output`, `fixture`: the checked-in proof fixtures. The schema digests and the output
 *   contract must equal the live compile.
 * - `artifact`: the checked-in CLI surface.
 * - `event`: `EVENT_ANNOTATIONS`, looked up for each nested `actionContract.emissions` entry.
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

  const dispatchRoutes: readonly DispatchRoute[] = collectDispatchRoutes(routerSources);
  const routes: RouteEntry[] = dispatchRoutes.map((r) => ({ actionId: r.actionId, tool: r.tool }));

  const handlers = bindings.map((b) => ({ tool: b.tool }));

  const owners = collectOwners(providers, rules);

  const shippedFixtures: readonly ShippedActionFixture[] = readShippedProofFixtures(fixturesFile);
  const shippedByActionId = new Map<string, ShippedActionFixture[]>();
  for (const entry of shippedFixtures) {
    const bucket = shippedByActionId.get(entry.actionId);
    if (bucket) bucket.push(entry);
    else shippedByActionId.set(entry.actionId, [entry]);
  }

  const fixtures: FixtureEntry[] = shippedFixtures.map((f) => ({ actionId: f.actionId }));

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

  const artifacts: ArtifactEntry[] = readShippedCliCommands(cliSurfaceFile).map((c) => ({
    actionId: c.actionId,
  }));

  const annotations = opts.annotations ?? EVENT_ANNOTATIONS;
  const emissions: EmissionEntry[] = [];
  for (const tool of opts.registry ?? TOOL_REGISTRY) {
    for (const action of tool.actions) {
      for (const emission of contractEmissionsOf(action)) {
        const registration = annotations[emission.event];
        emissions.push({
          actionId: `${tool.name}.${action.name}`,
          event: emission.event,
          registered: registration !== undefined,
        });
      }
    }
  }

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
    emissions,
    exceptions: opts.exceptions ?? LIVE_CLOSURE_EXCEPTIONS,
  };
}
