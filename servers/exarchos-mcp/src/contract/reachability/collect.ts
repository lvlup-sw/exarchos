// ─── Reachability inputs collector (P05-05) ──────────────────────────────────
//
// PROGRAM-05, the closure capstone (CTR-013). The impure adapter that assembles
// the pure {@link ReachabilityInputs} from the LIVE upstream authorities — one
// materialized projection per hop, so the closure model in `graph.ts` runs over
// the real tree, not a hand-maintained mirror:
//
//   • actions / schema / output / artifact  ← P03-03 `compile(deriveMetaModel())`
//   • route (dispatch)                        ← P03-04 `generateRegistration`
//   • handler                                 ← P03-04 `BINDING_TABLE`
//   • owner (where applicable)                ← P04-01 ledger via the provider map
//   • fixture (packaged proof)                ← the checked-in `proof-fixtures.json`
//
// It fails LOUD (throws) when an authority is itself broken — a blocked contract
// compile or a stale effect-provider map — rather than emitting a graph that
// silently mis-reports a break. The `authored workflow` origin is the ActionId
// itself; binding ActionIds to shared-IR built-in workflows is the P07-02 seam,
// intentionally left as a pluggable origin attribute (not read here).
// ────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';

import { deriveMetaModel } from '../compiler/meta-model.js';
import { compile, type CompiledContract } from '../compiler/compile.js';
import { PROOF_FIXTURES_FILE } from '../compiler/generate.js';
import {
  generateRegistration,
  registrationActionRefs,
  type RegistrationSource,
} from '../bindings/generate-registration.js';
import { BINDING_TABLE, type ImplementationBinding } from '../bindings/binding-table.js';
import { EFFECT_OWNERSHIP, type EffectOwnershipRule } from '../../architecture/effect-ledger.js';
import {
  EFFECT_PROVIDERS,
  assertValidProviders,
  type EffectProvider,
} from './providers.js';
import type {
  ActionNode,
  ClosureException,
  FixtureEntry,
  OwnerEntry,
  ReachabilityInputs,
} from './graph.js';

/**
 * The governed closure-exception list. EMPTY: the live tree achieves complete
 * closure for every public action, so nothing is excepted. An entry is added
 * only with a conscious, reviewed reason for a genuinely-unclosed action — and a
 * stale entry (an action that is actually closed) is itself flagged by
 * `evaluateClosure` (the two-way ratchet). Kept here, beside the collector, so
 * the governed exceptions travel with the live wiring.
 */
export const LIVE_CLOSURE_EXCEPTIONS: readonly ClosureException[] = Object.freeze([]);

/** Overridable inputs so a test can target another tree / snapshot. */
export interface CollectOptions {
  readonly compiled?: CompiledContract;
  readonly providers?: readonly EffectProvider[];
  readonly rules?: readonly EffectOwnershipRule[];
  readonly bindings?: readonly ImplementationBinding[];
  /** Path to the checked-in packaged proof-fixture baseline. */
  readonly fixturesFile?: string;
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
export function readPackagedFixtureActionIds(fixturesFile: string = PROOF_FIXTURES_FILE): readonly string[] {
  const raw: unknown = JSON.parse(fs.readFileSync(fixturesFile, 'utf8'));
  if (raw === null || typeof raw !== 'object' || !('actions' in raw)) {
    throw new Error(`reachability: packaged fixture baseline '${fixturesFile}' has no 'actions' array`);
  }
  const actions = (raw as { actions: unknown }).actions;
  if (!Array.isArray(actions)) {
    throw new Error(`reachability: packaged fixture baseline '${fixturesFile}' 'actions' is not an array`);
  }
  const ids: string[] = [];
  for (const entry of actions) {
    if (entry !== null && typeof entry === 'object' && typeof (entry as { actionId?: unknown }).actionId === 'string') {
      ids.push((entry as { actionId: string }).actionId);
    }
  }
  return ids;
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

/**
 * Assemble the live {@link ReachabilityInputs}. Deterministic and side-effect
 * free apart from reading the compiled contract + the checked-in fixture
 * baseline. Every projection is derived from a real authority; nothing is
 * hand-listed.
 */
export function collectReachabilityInputs(opts: CollectOptions = {}): ReachabilityInputs {
  const contract = opts.compiled ?? compileLive();
  const providers = opts.providers ?? EFFECT_PROVIDERS;
  const rules = opts.rules ?? EFFECT_OWNERSHIP;
  const bindings = opts.bindings ?? BINDING_TABLE;
  const fixturesFile = opts.fixturesFile ?? PROOF_FIXTURES_FILE;

  const actions: ActionNode[] = contract.descriptors.map((d) => ({
    actionId: d.actionId,
    tool: d.tool,
    action: d.action,
    mutates: d.policy.effect.mutates,
  }));

  const schemas = contract.descriptors
    .filter((d) => {
      const pair = contract.schemas.actions[d.actionId];
      return pair !== undefined && pair.input !== undefined && pair.output !== undefined;
    })
    .map((d) => ({ actionId: d.actionId }));

  const registrationSource: RegistrationSource = {
    surfaceVersion: contract.surfaceVersion,
    descriptors: contract.descriptors.map((d) => ({
      actionId: d.actionId,
      tool: d.tool,
      action: d.action,
      description: d.description,
    })),
  };
  const routes = registrationActionRefs(generateRegistration(registrationSource)).map((r) => ({
    actionId: r.actionId,
    tool: r.tool,
  }));

  const handlers = bindings.map((b) => ({ tool: b.tool }));

  const owners = collectOwners(providers, rules);

  const outputs = contract.descriptors.map((d) => ({
    actionId: d.actionId,
    outputKinds: [...d.outputKinds],
    errorCodes: [...d.errorCodes],
  }));

  const artifacts = contract.proofFixtures.actions.map((a) => ({ actionId: a.actionId }));

  const packagedIds = readPackagedFixtureActionIds(fixturesFile);
  const fixtures: FixtureEntry[] = packagedIds.map((actionId) => ({ actionId }));

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
