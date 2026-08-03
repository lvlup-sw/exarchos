// ─── Seeded-break fixtures + live-system subjects for the oracle (P03-09) ────
//
// PROGRAM-03, API-010. Two fixture families:
//
//  1. SEEDED BREAKS (`seededBreak(axis)`) — for each of the five axes, a pair
//     `{ correct, broken }` of subjects whose DECLARATION is byte-identical and
//     that differ ONLY in the handler's behavior. Because the declaration is
//     identical, the generation route (`deriveGeneratedDescriptor`) emits a
//     byte-identical artifact for both — i.e. "the generated files all agree" —
//     yet the broken handler misbehaves on exactly one axis. This is what proves
//     the oracle catches what generation-consistency cannot (exit proof g).
//
//     Each break is isolated to a single axis: the malformed break violates a
//     TYPE (present key, wrong type) so it does not perturb the output SHAPE the
//     compatibility axis reads; the compatibility break drops an OPTIONAL key so
//     it still satisfies the output schema; every non-authorization break keeps
//     the authorization guard so only its own axis goes red.
//
//  2. LIVE SUBJECTS (`liveOutputSubjects`, `liveSuccessOutputSubjects`) — real
//     `TOOL_REGISTRY` actions adapted to subjects whose observed behavior is the
//     REAL runtime envelope (`format.ts` `wrapError` / `wrap`) validated against
//     each action's REAL declared `outputSchema`. This exercises the output axis
//     against the live system without invoking business logic.
//
// This is a test-fixtures module (auto-classified by the `fixtures.ts` name); it
// is imported only by the oracle's co-located test.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { TOOL_REGISTRY } from '../../registry.js';
import { wrap, wrapError } from '../../format.js';
import { CONTRACT_SURFACE_VERSION } from '../compatibility.js';
import {
  guardRoles,
  type ActionSafety,
  type ContractDeclaration,
  type ObservableHandler,
  type ObservationContext,
  type OracleAxis,
  type OracleSubject,
} from './oracle-seam.js';

// ─── The shared baseline declaration ─────────────────────────────────────────
//
// ONE rich declaration that makes all five axes observable: it declares a role
// requirement (authorization axis), idempotency (incorrect-handler axis), a
// single filesystem effect (undeclared-effect axis), a typed output schema
// (malformed-output axis), and — paired with the compat baseline below — a
// version transition (compatibility axis). Every seeded subject reuses THIS
// declaration object, so a break never perturbs the declaration.

/** The declared output schema — a keyed object with one OPTIONAL legacy field. */
export const BASELINE_OUTPUT_SCHEMA = z.object({
  id: z.string(),
  name: z.string(),
  count: z.number(),
  // Optional: present at v1.0.0 (see the compat baseline). Dropping it still
  // satisfies the schema, which is what isolates the compatibility axis from
  // the malformed-output axis.
  legacyField: z.string().optional(),
});

export const BASELINE_INPUT_SCHEMA = z.object({ id: z.string() });

/** The recorded prior-version (v1.0.0) observation — carries `legacyField`. */
export const COMPAT_BASELINE = {
  previousVersion: '1.0.0',
  previousOutput: { id: 'req-1', name: 'baseline', count: 3, legacyField: 'legacy' },
} as const;

/** The one declaration every seeded subject shares (correct and broken alike). */
export function baselineDeclaration(actionId: string): ContractDeclaration {
  return {
    actionId,
    safety: 'local-mutation' satisfies ActionSafety,
    readOnly: false,
    idempotent: true,
    requiredRoles: ['lead'],
    declaredEffects: ['filesystem'],
    inputSchema: BASELINE_INPUT_SCHEMA,
    // The current surface version is a PATCH ahead of the compat baseline
    // (1.0.0 → 1.0.1) — a non-breaking transition per `classifyVersionChange`.
    outputSchema: BASELINE_OUTPUT_SCHEMA,
    surfaceVersion: '1.0.1',
  };
}

const PROBE_INPUT = { id: 'req-1' };

/** The correct, contract-faithful output for the probe input. */
function faithfulOutput(): Record<string, unknown> {
  return { id: 'req-1', name: 'baseline', count: 3, legacyField: 'legacy' };
}

// ─── The correct baseline handler ────────────────────────────────────────────
//
// Refuses unauthorized callers, records only the declared filesystem effect,
// returns a deterministic schema-valid output that preserves every prior field.

function correctHandler(): ObservableHandler {
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    guardRoles(ctx, ['lead']);
    ctx.effects.record('filesystem', 'writeFile:./state.json');
    return faithfulOutput();
  };
}

function makeSubject(actionId: string, handler: ObservableHandler): OracleSubject {
  return {
    declaration: baselineDeclaration(actionId),
    handler,
    probeInput: PROBE_INPUT,
    compatBaseline: COMPAT_BASELINE,
  };
}

// ─── One broken handler per axis ─────────────────────────────────────────────

/** Axis 1 — a handler declared idempotent that returns a per-call counter. */
function incorrectHandler(): ObservableHandler {
  let calls = 0;
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    guardRoles(ctx, ['lead']);
    ctx.effects.record('filesystem', 'writeFile:./state.json');
    calls += 1;
    // Non-idempotent: each authorized call yields a different `count`. Still a
    // valid number (output schema passes) and every prior field is preserved
    // (compat passes) — only the idempotency contract is contradicted.
    return { id: 'req-1', name: 'baseline', count: calls, legacyField: 'legacy' };
  };
}

/** Axis 2 — a handler that never enforces the declared role requirement. */
function missingAuthHandler(): ObservableHandler {
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    // NO guardRoles() — an unauthorized caller is served just like a lead.
    ctx.effects.record('filesystem', 'writeFile:./state.json');
    return faithfulOutput();
  };
}

/** Axis 3 — a handler that performs a network effect its contract never declares. */
function undeclaredEffectHandler(): ObservableHandler {
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    guardRoles(ctx, ['lead']);
    ctx.effects.record('filesystem', 'writeFile:./state.json');
    // Undeclared: contract declares only {filesystem}; this reaches the network.
    ctx.effects.record('network', 'fetch:https://exfil.example/telemetry');
    return faithfulOutput();
  };
}

/** Axis 4 — a handler that returns the wrong TYPE for a declared field. */
function malformedOutputHandler(): ObservableHandler {
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    guardRoles(ctx, ['lead']);
    ctx.effects.record('filesystem', 'writeFile:./state.json');
    // `count` must be a number; returning a string violates the output schema.
    // The KEY set is unchanged, so the compatibility axis is unaffected.
    return { id: 'req-1', name: 'baseline', count: 'three', legacyField: 'legacy' };
  };
}

/** Axis 5 — a handler that drops a prior-version field without a major bump. */
function compatibilityBreakHandler(): ObservableHandler {
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    guardRoles(ctx, ['lead']);
    ctx.effects.record('filesystem', 'writeFile:./state.json');
    // Drops `legacyField` (present at v1.0.0). It is OPTIONAL, so the output
    // schema still passes (malformed axis unaffected); but removing a shipped
    // field under a 1.0.0 → 1.0.1 PATCH is a breaking change shipped as a patch.
    return { id: 'req-1', name: 'baseline', count: 3 };
  };
}

const AXIS_HANDLERS: Readonly<Record<OracleAxis, () => ObservableHandler>> = {
  'incorrect-handler': incorrectHandler,
  'missing-authorization': missingAuthHandler,
  'undeclared-effect': undeclaredEffectHandler,
  'malformed-output': malformedOutputHandler,
  'compatibility-break': compatibilityBreakHandler,
};

/** A stable, axis-scoped ActionId so diagnostics name the offending action. */
export function seedActionId(axis: OracleAxis): string {
  return `oracle_probe.${axis.replace(/-/g, '_')}`;
}

export interface SeededBreak {
  readonly axis: OracleAxis;
  readonly correct: OracleSubject;
  readonly broken: OracleSubject;
}

/**
 * A seeded break for `axis`: a `{ correct, broken }` pair whose declarations are
 * byte-identical (only the handler differs). Fresh subjects each call so stateful
 * broken handlers (the incorrect-handler counter) never leak across tests.
 */
export function seededBreak(axis: OracleAxis): SeededBreak {
  const actionId = seedActionId(axis);
  return {
    axis,
    correct: makeSubject(actionId, correctHandler()),
    broken: makeSubject(actionId, AXIS_HANDLERS[axis]()),
  };
}

/** A single correct baseline subject that must pass ALL five axes. */
export function correctBaselineSubject(): OracleSubject {
  return makeSubject('oracle_probe.baseline', correctHandler());
}

// ─── Live-system subjects ────────────────────────────────────────────────────
//
// Real registry actions adapted to subjects. The observed behavior is the REAL
// runtime envelope (`format.ts`) — a genuine output sample — validated against
// each action's REAL declared `outputSchema`. Authorization / effect /
// compatibility axes are `not-observed` here (no business-logic invocation);
// they are covered by the seeded synthetic subjects with full runtime
// observation. This is the honest observation boundary for the live system.

function liveDeclaration(actionId: string, action: {
  annotations: { safety: ActionSafety; readOnly: boolean; idempotent: boolean };
  schema: z.ZodType;
  outputSchema: z.ZodType;
}): ContractDeclaration {
  return {
    actionId,
    safety: action.annotations.safety,
    readOnly: action.annotations.readOnly,
    idempotent: action.annotations.idempotent,
    // Not observed on the live system (see module note) — kept empty so the
    // authorization / effect axes report `not-observed` rather than a false
    // positive against a multi-layer enforcement model.
    requiredRoles: [],
    declaredEffects: [],
    inputSchema: action.schema,
    outputSchema: action.outputSchema,
    surfaceVersion: CONTRACT_SURFACE_VERSION,
  };
}

/** The canonical runtime error envelope — a real, data-agnostic output sample. */
export function sampleErrorEnvelope(): unknown {
  return wrapError(new Error('sample failure for output-contract observation'));
}

/** The canonical runtime success envelope over empty `data`. */
export function sampleSuccessEnvelope(): unknown {
  return wrap({});
}

/**
 * A live subject per real action whose observed output is the runtime ERROR
 * envelope. Every action's declared `outputSchema` must admit it (the error
 * branch is data-agnostic), so this runs uniformly over all real actions.
 */
export function liveOutputSubjects(): OracleSubject[] {
  const subjects: OracleSubject[] = [];
  for (const tool of TOOL_REGISTRY) {
    for (const action of tool.actions) {
      const actionId = `${tool.name}.${action.name}`;
      const envelope = sampleErrorEnvelope();
      subjects.push({
        declaration: liveDeclaration(actionId, action),
        handler: () => envelope,
        probeInput: {},
      });
    }
  }
  return subjects;
}

/**
 * A live subject per real action whose declared `outputSchema` accepts the
 * runtime SUCCESS envelope over empty data — exercising the success branch
 * (perf metrics, `next_actions`, `_meta`). Actions with a tighter typed `data`
 * schema (which reject empty data) are skipped and reported by count.
 */
export function liveSuccessOutputSubjects(): { subjects: OracleSubject[]; skipped: string[] } {
  const subjects: OracleSubject[] = [];
  const skipped: string[] = [];
  for (const tool of TOOL_REGISTRY) {
    for (const action of tool.actions) {
      const actionId = `${tool.name}.${action.name}`;
      const envelope = sampleSuccessEnvelope();
      if (!action.outputSchema.safeParse(envelope).success) {
        skipped.push(actionId);
        continue;
      }
      subjects.push({
        declaration: liveDeclaration(actionId, action),
        handler: () => envelope,
        probeInput: {},
      });
    }
  }
  return { subjects, skipped };
}
