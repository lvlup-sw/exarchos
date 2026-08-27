// ─── The independent contract-vs-behavior oracle (P03-09) ────────────────────
//
// PROGRAM-03, API-010. Exit proof: "seeded incorrect handlers, missing
// authorization, undeclared effects, malformed outputs, and compatibility
// breaks are caught EVEN WHEN GENERATED FILES AGREE."
//
// ## Why this exists — the blind spot every other PROGRAM-03 package shares
//
// Everything else in the chain is a GENERATION pipeline. The compiler (P03-03)
// derives a meta-model from the live `TOOL_REGISTRY`, projects descriptors and
// schemas (`compiler/descriptors.ts`), and emits a checked-in proof-fixture
// baseline; the binding generator (P03-04) projects the registration manifest
// and reconciles it against the loader table; the CLI generator (P03-05)
// projects a client. Every one of those layers, and every drift guard that
// polices them, is a pure function of the DECLARED contract. They compare a
// declaration to another declaration derived from the same declaration.
//
// That means: if the meta-model itself is wrong, or a handler quietly does
// something its contract never declared, EVERY generated artifact agrees with
// every other generated artifact and the whole system is self-consistently
// wrong. Declaration-to-declaration drift guards cannot see it.
//
// ## How this oracle is INDEPENDENT of that pipeline
//
//   1. It never calls `deriveMetaModel()` / `compile()` and never reads the
//      checked-in `generated/proof-fixtures.json`. It derives its expectations
//      DIRECTLY from the declared contract (`ContractDeclaration`) and the frozen
//      P03-02 contract-surface primitives (`error-families`, `envelope`,
//      `compatibility`) — a different route than the compiler's transform.
//   2. Its decisive signal is OBSERVED BEHAVIOR, not another declaration. It
//      invokes the handler against a probe, watches the effects it actually
//      performs (a runtime effect recorder), probes it with an unauthorized
//      caller, validates the value it actually returns against the declared
//      output schema, and compares the output shape it actually emits against a
//      recorded prior-version observation. Behavior is a genuinely different
//      information source than any generated file.
//
// The independence is provable, not asserted: a seeded break leaves the
// DECLARATION byte-identical (only the handler misbehaves), so
// `deriveGeneratedDescriptor()` — the faithful model of the generation route —
// produces a byte-identical artifact for the broken and the correct subject.
// No generation/drift check can tell them apart; the oracle tells them apart by
// observing behavior. See `oracle-seam.test.ts` exit proof (g).
//
// ## `not-observed` is NOT `pass` (DR-24)
//
// An axis has THREE outcomes, and the third one is load-bearing: `pass` means
// "we looked and it was fine", `fail` means "we looked and it was broken", and
// `not-observed` means "we did not look". Reporting `pass` for an axis that was
// never exercised is how an oracle silently goes vacuous — it reads green on a
// system it never inspected. So every axis here refuses to emit `pass` without
// positive evidence:
//
//   • authorization is DIFFERENTIAL — the handler must SERVE an authorized
//     caller and REFUSE an unauthorized one, through a real
//     {@link AuthorizationSurface}. An empty / open-marker role set, a subject
//     with no probeable surface, or a handler that refuses everyone all yield
//     `not-observed`.
//   • the effect axis requires effect EVIDENCE (a runtime record or a static
//     scan). An empty recorder cannot distinguish "performed nothing" from
//     "was never instrumented", so it yields `not-observed`.
//   • idempotency is not compared when the authorized probe was declined.
//
// {@link axisCoverage} then makes the residual vacuity legible: an axis whose
// `observed` count is zero across a suite reported nothing at all.
//
// This module is a TEST-INVOKED source-lint gate (the `-seam.ts` convention):
// its co-located test runs `runOracleSuite()` against the real registry and
// against the seeded-break fixtures. It exports pure analysis functions; it is
// not a production import target.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { canonicalJson } from '../request-context.js';
import { digestText } from '../authority-digest.js';
import { zodToJsonSchema } from '../../utils/json-schema.js';
import { layerCodes } from '../error-families.js';
import { OUTPUT_KINDS } from '../envelope.js';
import { classifyVersionChange, type CompatibilityClass } from '../compatibility.js';
import {
  detectModuleEffects,
  type EffectClass,
  type ModuleLexer,
} from '../../architecture/effect-ledger.js';

// ─── The five detection axes ─────────────────────────────────────────────────

/** The five independently-seedable, independently-reported detection axes. */
export const ORACLE_AXES = [
  'incorrect-handler',
  'missing-authorization',
  'undeclared-effect',
  'malformed-output',
  'compatibility-break',
] as const;
export type OracleAxis = (typeof ORACLE_AXES)[number];

/** The action safety class (mirrors the registry `ActionAnnotations.safety`). */
export type ActionSafety = 'read-only' | 'local-mutation' | 'remote-mutation' | 'compensable';

/**
 * One event a contract declares a handler appends, in the SAME `{event,
 * condition}` vocabulary the registry declares, the compiler compiles and the
 * dispatch verifier enforces.
 *
 * `condition` is the whole reason this is a record rather than a bare event
 * name. An `always` edge is PROMISED on every call, so its absence is a fault.
 * A `conditional` edge fires only when the run takes the branch that produces
 * it, so its absence proves nothing and can never be a fault — it can only
 * corroborate, by landing. Flattening the two into one list is how an axis
 * starts failing handlers for taking a branch they were entitled to take.
 */
export interface DeclaredEmission {
  readonly event: string;
  readonly condition: 'always' | 'conditional';
}

// ─── The declared contract (the oracle's expectation source) ─────────────────

/**
 * What a contract DECLARES about one action. The oracle reads this directly —
 * NOT via the compiler's meta-model transform — and derives per-axis
 * expectations from it. Every field is a declaration; none is behavior.
 */
export interface ContractDeclaration {
  readonly actionId: string;
  readonly safety: ActionSafety;
  readonly readOnly: boolean;
  /** Declared idempotency — repeated identical-input calls must not diverge. */
  readonly idempotent: boolean;
  /**
   * The authorization requirement: the roles a caller must hold. Empty means
   * the action declares no role requirement (authorization axis not observed).
   */
  readonly requiredRoles: readonly string[];
  /** The effect classes the contract declares this handler may perform. */
  readonly declaredEffects: readonly EffectClass[];
  /**
   * The events the contract declares this handler appends, each with the
   * condition under which it is promised. Optional: a subject whose observed
   * function is not the action's handler has no append to attribute, so it
   * declares none and the emission axis reports `not-observed` rather than a
   * vacuous `pass`.
   */
  readonly declaredEmissions?: readonly DeclaredEmission[];
  /** The declared input schema. */
  readonly inputSchema: z.ZodType;
  /** The declared output schema (the value a handler returns must satisfy it). */
  readonly outputSchema: z.ZodType;
  /** The current declared contract-surface version (for the compatibility axis). */
  readonly surfaceVersion: string;
}

// ─── Runtime observation surface ─────────────────────────────────────────────

/** One effect the handler actually performed, as recorded at runtime. */
export interface EffectEvent {
  readonly effectClass: EffectClass;
  readonly evidence: string;
}

/**
 * A runtime effect recorder threaded into the handler's observation context. In
 * a real deployment these records are emitted by the narrow, per-module effect
 * ports (P07-06 `*-effect-port-seam.ts`); the synthetic fixtures model that by
 * having the handler call `record()` at the point it performs an effect. Either
 * way this is a genuinely independent signal from the static effect ledger
 * (P04-01), which can only see import surface.
 */
export interface EffectRecorder {
  record(effectClass: EffectClass, evidence: string): void;
  readonly performed: readonly EffectEvent[];
}

export function createEffectRecorder(): EffectRecorder {
  const performed: EffectEvent[] = [];
  return {
    record(effectClass: EffectClass, evidence: string): void {
      performed.push({ effectClass, evidence });
    },
    get performed(): readonly EffectEvent[] {
      return performed;
    },
  };
}

/** One event the handler actually appended, as recorded at runtime. */
export interface EmissionEvent {
  readonly eventType: string;
  readonly evidence: string;
}

/**
 * A runtime emission recorder threaded into the handler's observation context,
 * minted the exact way {@link EffectRecorder} is (see the three mint sites in
 * {@link observeBehavior}). Its evidence is an OBSERVED append: a handler that
 * threads a real event-store append through `record()` at the point it commits
 * is the difference between "declared to emit" and "was seen appending" —
 * re-reading the declaration would be tautological.
 */
export interface EmissionRecorder {
  record(eventType: string, evidence: string): void;
  readonly appended: readonly EmissionEvent[];
}

export function createEmissionRecorder(): EmissionRecorder {
  const appended: EmissionEvent[] = [];
  return {
    record(eventType: string, evidence: string): void {
      appended.push({ eventType, evidence });
    },
    get appended(): readonly EmissionEvent[] {
      return appended;
    },
  };
}

/** The caller identity/authorization the oracle presents to a handler. */
export interface Caller {
  readonly subjectId: string;
  readonly roles: readonly string[];
}

/** The context an observed handler runs against. */
export interface ObservationContext {
  readonly caller: Caller;
  readonly effects: EffectRecorder;
  /**
   * The emission recorder. Optional on the TYPE only so the one
   * existing caller-constructed literal (`fixtures.ts`'s admission probe)
   * keeps compiling unchanged; {@link observeBehavior} always mints and
   * injects one, so a handler reached through the oracle can rely on it being
   * present.
   */
  readonly emissions?: EmissionRecorder;
}

/**
 * An observable handler — the real, invocable behavior. Returns the output value
 * that must satisfy the declared output schema. On an unauthorized caller a
 * well-behaved handler REFUSES (throws {@link UnauthorizedError} or returns a
 * `success:false` envelope with an authorization code).
 */
export type ObservableHandler = (
  input: unknown,
  ctx: ObservationContext,
) => unknown | Promise<unknown>;

/** The authorization stable codes a refusal may carry (P03-02 error families). */
export const AUTHORIZATION_CODES: ReadonlySet<string> = new Set(
  layerCodes('authorization'),
);

/** The sanctioned way a handler declines an unauthorized caller. */
export class UnauthorizedError extends Error {
  readonly code: string;
  constructor(message = 'caller is not authorized', code = 'AUTHORIZATION_DENIED') {
    super(message);
    this.name = 'UnauthorizedError';
    this.code = code;
  }
}

/**
 * The registry's OPEN-role marker (`roles: new Set(['any'])`): every
 * authenticated caller holds it, so it expresses NO restrictive requirement.
 * An action declaring only this marker has nothing for the authorization axis
 * to observe — see {@link checkMissingAuthorization} (DR-24).
 */
export const OPEN_ROLE_MARKER = 'any';

/** Throw {@link UnauthorizedError} unless the caller holds every required role. */
export function guardRoles(ctx: ObservationContext, requiredRoles: readonly string[]): void {
  if (requiredRoles.length === 0) return;
  const held = new Set(ctx.caller.roles);
  // `any` is the registry's open-role marker: any authenticated caller holds it.
  const authorized = requiredRoles.some(
    (role) => role === OPEN_ROLE_MARKER || held.has(role),
  );
  if (!authorized) {
    throw new UnauthorizedError(
      `caller '${ctx.caller.subjectId}' holds {${ctx.caller.roles.join(', ')}}, ` +
        `requires one of {${requiredRoles.join(', ')}}`,
    );
  }
}

/** A recorded observation of the action's behavior at a prior surface version. */
export interface CompatBaseline {
  readonly previousVersion: string;
  readonly previousOutput: Readonly<Record<string, unknown>>;
}

/**
 * How the oracle's synthetic {@link Caller} reaches the handler's REAL
 * authorization surface (DR-24).
 *
 *  • `observation-context` — the handler reads `ctx.caller` directly, so the
 *    {@link ObservationContext} IS the principal (the seeded subjects, whose
 *    correct arm calls {@link guardRoles}).
 *  • `dispatch-authority` — a real adapter projects the caller onto the REAL
 *    runtime authorization substrate (the trusted caller-authorization
 *    snapshot carried on the dispatch async scope) before invoking the real
 *    handler, so withholding the principal is a genuine runtime condition.
 *
 * A subject that OMITS this field has no probeable authorization surface, and
 * the authorization axis then reports `not-observed` — **never** `pass`. That
 * asymmetry is deliberate: because "we did not look" is not a passing outcome,
 * omitting the surface buys a subject nothing.
 */
export type AuthorizationSurface = 'observation-context' | 'dispatch-authority';

/**
 * The two shapes a runtime-owned per-call carrier can take. The kind is what
 * makes {@link VolatileCarrier} auditable: the oracle checks the OBSERVED
 * values against it before honoring the mask.
 *
 *  • `measurement-block` — an object whose every value is a number, i.e. a
 *    measurement of THAT call (the `_perf` block a real composite handler
 *    stamps with elapsed ms / bytes / tokens).
 *  • `generation-timestamp` — an ISO-8601 instant recording WHEN the answer
 *    was computed, not WHAT the answer is.
 */
export type VolatileCarrierKind = 'measurement-block' | 'generation-timestamp';

/** A dot-path into the output that carries per-call runtime bookkeeping. */
export interface VolatileCarrier {
  /** Dot-path, e.g. `_perf` or `data.session.start`. */
  readonly path: string;
  readonly kind: VolatileCarrierKind;
}

/** A subject the oracle can observe: a declared contract plus real behavior. */
export interface OracleSubject {
  readonly declaration: ContractDeclaration;
  readonly handler: ObservableHandler;
  /** The probe input the oracle feeds the handler. */
  readonly probeInput: unknown;
  /** Enables the compatibility axis: the recorded prior-version observation. */
  readonly compatBaseline?: CompatBaseline;
  /**
   * Enables the authorization axis. Absent ⇒ the oracle cannot withhold a
   * principal from this handler, so the axis is `not-observed`.
   */
  readonly authorizationSurface?: AuthorizationSurface;
  /**
   * Runtime-owned, per-call carriers to exclude from the IDEMPOTENCY
   * comparison only — never from schema validation and never from the
   * compatibility shape comparison.
   *
   * A mask is a hole in an oracle, so this one is not taken on trust: each
   * carrier declares its {@link VolatileCarrierKind} and the oracle HONORS it
   * only when both observed values actually match that kind (see
   * {@link honorsCarrier}). A path that is present but holds something other
   * than the declared carrier shape has its mask REFUSED, stays in the
   * comparison, and is named in the axis diagnostic — so a mask can never be
   * widened to swallow a real behavioral divergence.
   */
  readonly volatileCarriers?: readonly VolatileCarrier[];
  /**
   * Optional handler source for the COMPLEMENTARY static effect scan (P04-01).
   * Runtime effect recording is the primary signal; this cross-checks it.
   *
   * The source and the lexer that reads it are ONE optional field rather than
   * two, so a caller cannot supply the subject without also supplying the
   * instrument. `detectModuleEffects` needs a {@link ModuleLexer} port since
   * DR-26 / task 065 — the effect ledger is shipped source and cannot import the
   * TypeScript compiler — and a separate optional lexer would let this branch
   * silently not run while looking configured.
   *
   * **R-11, recorded rather than fixed (task 065).** Nothing in the tree sets
   * this field: the static-effect branch below is unreachable in practice and
   * `staticEffects` is always `[]`. It is not this task's to wire, but a reader
   * should not mistake it for a live cross-check.
   */
  readonly handlerSource?: {
    readonly source: string;
    readonly lex: ModuleLexer;
  };
}

// ─── Observation ─────────────────────────────────────────────────────────────

export interface Observation {
  readonly output: unknown;
  readonly outputRepeat: unknown;
  /**
   * {@link output} / {@link outputRepeat} with every HONORED
   * {@link VolatileCarrier} stripped — the basis for the idempotency
   * comparison.
   */
  readonly comparableOutput: unknown;
  readonly comparableOutputRepeat: unknown;
  /** Carrier paths actually masked out of the idempotency comparison. */
  readonly maskedCarriers: readonly string[];
  /**
   * Carrier paths that were PRESENT in both observed outputs but did not hold
   * the declared carrier shape. Their masks were refused: the values stayed in
   * the idempotency comparison and are named in the axis diagnostic.
   */
  readonly refusedCarriers: readonly string[];
  readonly performedEffects: readonly EffectEvent[];
  readonly staticEffects: readonly EffectClass[];
  /**
   * Events OBSERVED appended during the authorized probe — never a
   * re-read of {@link ContractDeclaration.declaredEmissions}. See
   * {@link checkDeclaredEmission}.
   */
  readonly performedEmissions: readonly EmissionEvent[];
  /**
   * Whether ANY effect evidence was collected at all (a runtime record or a
   * static scan). False ⇒ the handler's effects were NOT observed, which the
   * effect axis must report as `not-observed` rather than a vacuous `pass`.
   */
  readonly effectsObserved: boolean;
  /** Whether the subject exposed an authorization surface the oracle could probe. */
  readonly authorizationProbed: boolean;
  /** The authorization surface actually used, when one was available. */
  readonly authorizationSurface?: AuthorizationSurface;
  /**
   * Whether the AUTHORIZED probe was itself declined. A handler that refuses
   * EVERYONE tells us nothing about authorization: its refusal of the intruder
   * is not evidence that a requirement is enforced.
   */
  readonly authorizedRefused: boolean;
  readonly unauthorizedRefused: boolean;
  readonly unauthorizedDetail: string;
  /** Set when the AUTHORIZED probe threw unexpectedly (a handler contradiction). */
  readonly invocationError?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRefusal(value: unknown, error: unknown): boolean {
  if (error !== undefined) {
    // A handler that declines by throwing is refusing. Prefer an explicit
    // authorization signal, but any thrown refusal counts.
    if (error instanceof UnauthorizedError) return true;
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && AUTHORIZATION_CODES.has(code)) return true;
    }
    return true;
  }
  // A handler that declines by returning a `success:false` envelope also refuses.
  if (typeof value === 'object' && value !== null) {
    const v = value as { success?: unknown };
    if (v.success === false) return true;
  }
  return false;
}

/**
 * Read a dot-path out of a plain-object tree. `found:false` means the path is
 * absent (or crosses a non-object), which is NOT a refusal — there is simply
 * nothing to mask.
 */
function readPath(value: unknown, segments: readonly string[]): { found: boolean; value: unknown } {
  let cursor: unknown = value;
  for (const segment of segments) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
      return { found: false, value: undefined };
    }
    const record = cursor as Record<string, unknown>;
    if (!Object.hasOwn(record, segment)) return { found: false, value: undefined };
    cursor = record[segment];
  }
  return { found: true, value: cursor };
}

/** Structurally-shared copy of `value` with `segments` removed. */
function deletePath(value: unknown, segments: readonly string[]): unknown {
  if (segments.length === 0) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const [head, ...rest] = segments as [string, ...string[]];
  if (!Object.hasOwn(record, head)) return value;
  const out: Record<string, unknown> = { ...record };
  if (rest.length === 0) delete out[head];
  else out[head] = deletePath(record[head], rest);
  return out;
}

/** An ISO-8601 instant — the shape a `generation-timestamp` carrier must hold. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * Does the OBSERVED pair actually match the declared carrier kind? This is the
 * check that keeps {@link VolatileCarrier} from becoming a hole in the oracle:
 * a mask is honored only against the shape it claims to be masking, so
 * declaring `{ path: 'data', kind: 'generation-timestamp' }` over a real
 * payload masks nothing.
 */
function honorsCarrier(kind: VolatileCarrierKind, first: unknown, second: unknown): boolean {
  if (kind === 'generation-timestamp') {
    return [first, second].every((v) => typeof v === 'string' && ISO_INSTANT.test(v));
  }
  return [first, second].every(
    (v) =>
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      Object.values(v as Record<string, unknown>).length > 0 &&
      Object.values(v as Record<string, unknown>).every((n) => typeof n === 'number'),
  );
}

interface MaskResult {
  readonly first: unknown;
  readonly second: unknown;
  readonly masked: readonly string[];
  readonly refused: readonly string[];
}

/**
 * Build the idempotency comparison basis by stripping the carriers the oracle
 * is willing to honor. Present-but-wrong-shaped carriers are refused and
 * reported; absent carriers are silently skipped.
 */
function maskVolatileCarriers(
  first: unknown,
  second: unknown,
  carriers: readonly VolatileCarrier[],
): MaskResult {
  let maskedFirst = first;
  let maskedSecond = second;
  const masked: string[] = [];
  const refused: string[] = [];
  for (const carrier of carriers) {
    const segments = carrier.path.split('.');
    const a = readPath(first, segments);
    const b = readPath(second, segments);
    if (!a.found || !b.found) continue; // nothing to mask on this output
    if (!honorsCarrier(carrier.kind, a.value, b.value)) {
      refused.push(carrier.path);
      continue;
    }
    maskedFirst = deletePath(maskedFirst, segments);
    maskedSecond = deletePath(maskedSecond, segments);
    masked.push(carrier.path);
  }
  return { first: maskedFirst, second: maskedSecond, masked, refused };
}

/**
 * Observe the subject's actual behavior: invoke the handler against the probe
 * (twice, for idempotency), watch the effects it performs, and probe it with an
 * unauthorized caller. Pure observation — no comparison to the contract yet.
 */
export async function observeBehavior(subject: OracleSubject): Promise<Observation> {
  const { handler, probeInput, declaration } = subject;
  const authorizedRoles = declaration.requiredRoles.length > 0
    ? [...declaration.requiredRoles]
    : [OPEN_ROLE_MARKER];

  // Authorized invocation #1 — the observed output + performed effects/emissions.
  const rec1 = createEffectRecorder();
  const emissionRec1 = createEmissionRecorder();
  let output: unknown;
  let invocationError: string | undefined;
  try {
    output = await handler(probeInput, {
      caller: { subjectId: 'oracle-authorized', roles: authorizedRoles },
      effects: rec1,
      emissions: emissionRec1,
    });
  } catch (err) {
    invocationError = errorMessage(err);
  }

  // Authorized invocation #2 — the idempotency witness (fresh recorders).
  const rec2 = createEffectRecorder();
  const emissionRec2 = createEmissionRecorder();
  let outputRepeat: unknown;
  if (invocationError === undefined) {
    try {
      outputRepeat = await handler(probeInput, {
        caller: { subjectId: 'oracle-authorized', roles: authorizedRoles },
        effects: rec2,
        emissions: emissionRec2,
      });
    } catch (err) {
      // A handler that succeeds once then throws is itself a contradiction.
      invocationError = `second invocation diverged by throwing: ${errorMessage(err)}`;
    }
  }

  // Unauthorized probe — a caller holding NO roles.
  const rec3 = createEffectRecorder();
  const emissionRec3 = createEmissionRecorder();
  let unauthorizedRefused = false;
  let unauthorizedDetail = '';
  {
    let value: unknown;
    let error: unknown;
    try {
      value = await handler(probeInput, {
        caller: { subjectId: 'oracle-intruder', roles: [] },
        effects: rec3,
        emissions: emissionRec3,
      });
    } catch (err) {
      error = err;
    }
    unauthorizedRefused = isRefusal(value, error);
    unauthorizedDetail = error !== undefined ? `refused: ${errorMessage(error)}` : 'returned a value';
  }

  const staticEffects = subject.handlerSource !== undefined
    ? detectModuleEffects(
        declaration.actionId,
        subject.handlerSource.source,
        subject.handlerSource.lex,
      ).map((e) => e.effectClass)
    : [];

  const mask = maskVolatileCarriers(output, outputRepeat, subject.volatileCarriers ?? []);

  return {
    output,
    outputRepeat,
    comparableOutput: mask.first,
    comparableOutputRepeat: mask.second,
    maskedCarriers: mask.masked,
    refusedCarriers: mask.refused,
    performedEffects: rec1.performed,
    staticEffects,
    effectsObserved: rec1.performed.length > 0 || staticEffects.length > 0,
    performedEmissions: emissionRec1.appended,
    authorizationProbed: subject.authorizationSurface !== undefined,
    ...(subject.authorizationSurface !== undefined
      ? { authorizationSurface: subject.authorizationSurface }
      : {}),
    // A thrown authorized probe is a contradiction, not a refusal — the
    // incorrect-handler axis owns it; here it only means "not served".
    authorizedRefused: invocationError !== undefined || isRefusal(output, undefined),
    unauthorizedRefused,
    unauthorizedDetail,
    ...(invocationError !== undefined ? { invocationError } : {}),
  };
}

// ─── Per-axis verdicts ───────────────────────────────────────────────────────

export type AxisStatus = 'pass' | 'fail' | 'not-observed';

export interface AxisVerdict {
  readonly axis: OracleAxis;
  readonly actionId: string;
  readonly status: AxisStatus;
  readonly diagnostic: string;
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Axis 1 — INCORRECT HANDLER. Observed behavior contradicts a declared
 * behavioral property. Two independent contradictions: (a) a handler that
 * throws on a valid authorized probe, and (b) a handler DECLARED idempotent
 * whose two identical-input invocations diverge.
 */
export function checkIncorrectHandler(
  decl: ContractDeclaration,
  obs: Observation,
): AxisVerdict {
  const axis: OracleAxis = 'incorrect-handler';
  if (obs.invocationError !== undefined) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'fail',
      diagnostic:
        `handler contradicts its contract: an authorized, schema-valid probe was ` +
        `not served — ${obs.invocationError}`,
    };
  }
  if (!decl.idempotent) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'not-observed',
      diagnostic: 'contract does not declare idempotency — no behavioral property to observe',
    };
  }
  if (obs.authorizedRefused) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'not-observed',
      diagnostic:
        'the authorized probe was DECLINED, so the handler exhibited a refusal rather than ' +
        'the action\'s behavior — idempotency was NOT observed',
    };
  }
  const a = canonicalJson(obs.comparableOutput);
  const b = canonicalJson(obs.comparableOutputRepeat);
  const notes: string[] = [];
  if (obs.maskedCarriers.length > 0) {
    notes.push(`runtime-owned carriers masked: [${[...obs.maskedCarriers].sort(byString).join(', ')}]`);
  }
  if (obs.refusedCarriers.length > 0) {
    notes.push(
      `mask REFUSED (declared shape not observed, value left in the comparison): ` +
      `[${[...obs.refusedCarriers].sort(byString).join(', ')}]`,
    );
  }
  const maskNote = notes.length > 0 ? ` (${notes.join('; ')})` : '';
  if (a !== b) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'fail',
      diagnostic:
        `handler is declared idempotent but two identical-input invocations diverged${maskNote}: ` +
        `${a} vs ${b}`,
    };
  }
  return {
    axis,
    actionId: decl.actionId,
    status: 'pass',
    diagnostic: `idempotent as declared; identical-input invocations agree${maskNote}`,
  };
}

/**
 * Axis 2 — MISSING AUTHORIZATION. A declared authorization requirement that is
 * not actually enforced at runtime. Observed DIFFERENTIALLY: the handler must
 * SERVE an authorized caller and REFUSE an unauthorized one. Anything less is
 * `not-observed` (DR-24) — never `pass`, because:
 *
 *  • an empty / open-marker role set declares no restrictive requirement;
 *  • a subject with no {@link AuthorizationSurface} never had a principal
 *    withheld from it, so nothing about enforcement was observed; and
 *  • a handler that refuses EVERYONE (its authorized probe was declined too)
 *    proves nothing — a blanket failure is not evidence of enforcement.
 */
export function checkMissingAuthorization(
  decl: ContractDeclaration,
  obs: Observation,
): AxisVerdict {
  const axis: OracleAxis = 'missing-authorization';
  if (decl.requiredRoles.length === 0) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'not-observed',
      diagnostic: 'contract declares no role requirement — nothing to enforce',
    };
  }
  if (decl.requiredRoles.every((role) => role === OPEN_ROLE_MARKER)) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'not-observed',
      diagnostic:
        `contract declares only the open-role marker {${OPEN_ROLE_MARKER}} — every ` +
        `authenticated caller holds it, so there is no restrictive requirement to enforce`,
    };
  }
  if (!obs.authorizationProbed) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'not-observed',
      diagnostic:
        `declared requirement {${decl.requiredRoles.join(', ')}} was NOT probed: this subject ` +
        `exposes no authorization surface, so no principal could be withheld from the handler`,
    };
  }
  if (obs.authorizedRefused) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'not-observed',
      diagnostic:
        `the AUTHORIZED probe was declined too, so refusing the unauthorized caller is not ` +
        `evidence that {${decl.requiredRoles.join(', ')}} is enforced — enforcement NOT observed`,
    };
  }
  if (obs.unauthorizedRefused) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'pass',
      diagnostic:
        `declared requirement {${decl.requiredRoles.join(', ')}} is enforced via ` +
        `'${obs.authorizationSurface ?? 'unknown'}' (authorized caller served; ` +
        `unauthorized caller ${obs.unauthorizedDetail})`,
    };
  }
  return {
    axis,
    actionId: decl.actionId,
    status: 'fail',
    diagnostic:
      `declared authorization requirement {${decl.requiredRoles.join(', ')}} is NOT enforced: ` +
      `an unauthorized caller (no roles) was served instead of refused`,
  };
}

/**
 * Axis 3 — UNDECLARED EFFECT. A handler performing an effect its contract does
 * not declare. Primary signal is RUNTIME (the effect recorder); the static
 * import scan (P04-01) is a complementary cross-check.
 *
 * DR-24: with NO evidence at all — no runtime record, no static scan — the
 * handler's effects were never observed. That is reported `not-observed`, never
 * `pass`: an empty recorder cannot distinguish "performed nothing" from
 * "was never instrumented", and the latter must not read as a clean bill.
 */
export function checkUndeclaredEffect(
  decl: ContractDeclaration,
  obs: Observation,
): AxisVerdict {
  const axis: OracleAxis = 'undeclared-effect';
  const declared = new Set<EffectClass>(decl.declaredEffects);

  if (!obs.effectsObserved) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'not-observed',
      diagnostic:
        `no effect evidence was collected — the handler recorded no runtime effect and no ` +
        `handler source was supplied for the static cross-check, so its effects were NOT ` +
        `observed against the declared set ` +
        `{${[...declared].sort(byString).join(', ') || 'none'}}`,
    };
  }

  const runtimeUndeclared = [
    ...new Set(
      obs.performedEffects
        .filter((e) => !declared.has(e.effectClass))
        .map((e) => e.effectClass),
    ),
  ].sort(byString);

  if (runtimeUndeclared.length > 0) {
    const evidence = obs.performedEffects
      .filter((e) => runtimeUndeclared.includes(e.effectClass))
      .map((e) => `${e.effectClass}(${e.evidence})`)
      .join(', ');
    return {
      axis,
      actionId: decl.actionId,
      status: 'fail',
      diagnostic:
        `handler performed undeclared effect(s) [${runtimeUndeclared.join(', ')}] at runtime — ` +
        `declared {${[...declared].sort(byString).join(', ') || 'none'}}; observed ${evidence}`,
    };
  }

  const staticUndeclared = [
    ...new Set(obs.staticEffects.filter((c) => !declared.has(c))),
  ].sort(byString);
  if (staticUndeclared.length > 0) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'fail',
      diagnostic:
        `handler source statically imports undeclared effect(s) [${staticUndeclared.join(', ')}] — ` +
        `declared {${[...declared].sort(byString).join(', ') || 'none'}} (static cross-check)`,
    };
  }

  return {
    axis,
    actionId: decl.actionId,
    status: 'pass',
    diagnostic:
      `every performed effect is declared ` +
      `(declared {${[...declared].sort(byString).join(', ') || 'none'}}, ` +
      `performed {${obs.performedEffects.map((e) => e.effectClass).join(', ') || 'none'}})`,
  };
}

/**
 * Axis 4 — MALFORMED OUTPUT. A handler returning a value that violates its
 * declared output schema. Observed by validating the ACTUAL returned value
 * against the DECLARED Zod schema directly (not the compiler's JSON projection).
 */
export function checkMalformedOutput(
  decl: ContractDeclaration,
  obs: Observation,
): AxisVerdict {
  const axis: OracleAxis = 'malformed-output';
  if (obs.invocationError !== undefined) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'not-observed',
      diagnostic: 'handler produced no output to validate (it threw) — see incorrect-handler',
    };
  }
  const result = decl.outputSchema.safeParse(obs.output);
  if (result.success) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'pass',
      diagnostic: 'returned value satisfies the declared output schema',
    };
  }
  const issues = result.error.issues
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
  return {
    axis,
    actionId: decl.actionId,
    status: 'fail',
    diagnostic: `returned value violates the declared output schema (OUTPUT_CONTRACT_VIOLATION): ${issues}`,
  };
}

/**
 * Axis 5 — COMPATIBILITY BREAK. A change violating the declared compatibility
 * policy: the output shape actually emitted dropped a field the prior-version
 * observation carried (a breaking structural change), yet the declared version
 * transition does not classify as breaking. Uses P03-02 `classifyVersionChange`
 * — independent of the compiler.
 */
export function checkCompatibilityBreak(
  subject: OracleSubject,
  obs: Observation,
): AxisVerdict {
  const axis: OracleAxis = 'compatibility-break';
  const decl = subject.declaration;
  const baseline = subject.compatBaseline;
  if (baseline === undefined) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'not-observed',
      diagnostic: 'no prior-version observation recorded — compatibility not observed',
    };
  }
  if (typeof obs.output !== 'object' || obs.output === null || Array.isArray(obs.output)) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'not-observed',
      diagnostic: 'current output is not a keyed object — compatibility shape not comparable',
    };
  }
  const current = obs.output as Record<string, unknown>;
  const removed = Object.keys(baseline.previousOutput)
    .filter((k) => !(k in current))
    .sort(byString);
  const change: CompatibilityClass = classifyVersionChange(
    baseline.previousVersion,
    decl.surfaceVersion,
  );
  if (removed.length > 0 && change !== 'breaking') {
    return {
      axis,
      actionId: decl.actionId,
      status: 'fail',
      diagnostic:
        `output dropped field(s) [${removed.join(', ')}] present at ${baseline.previousVersion} — ` +
        `a breaking structural change — but the declared transition ` +
        `${baseline.previousVersion} → ${decl.surfaceVersion} classifies as '${change}', not 'breaking'`,
    };
  }
  if (removed.length > 0) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'pass',
      diagnostic:
        `output dropped field(s) [${removed.join(', ')}] but the declared transition is 'breaking' — declared`,
    };
  }
  return {
    axis,
    actionId: decl.actionId,
    status: 'pass',
    diagnostic: `output preserves every prior-version field (${baseline.previousVersion} → ${decl.surfaceVersion})`,
  };
}

// ─── The emission axis ────────────────────────────────────────────────
//
// Reported SEPARATELY from {@link ORACLE_AXES} rather than folded into that
// closed union: `fixtures.ts`'s `AXIS_HANDLERS` is typed `Record<OracleAxis, …>`
// over the five original seedable axes, and this axis's own seeded-break
// fixture and live-subject wiring are a later task's to add. The axis is
// reported on {@link OracleReport.emissionVerdict}, using the identical
// {@link AxisStatus} vocabulary, and participates in `ok` and `failures`
// exactly as the other five do.

/** The emission axis identifier — a member of {@link ALL_AXES}, not of {@link ORACLE_AXES}. */
export const EMISSION_AXIS = 'declared-emission';
export type EmissionAxis = typeof EMISSION_AXIS;

/**
 * The full selectable surface: the five originally-seedable {@link ORACLE_AXES}
 * plus the emission axis. `ORACLE_AXES` stays five-membered — `seededBreak`,
 * `axisCoverage` and the per-axis `it.each` tests are keyed on exactly those
 * five — but `RunOracleOptions.axes` selects from this six-member tuple, so the
 * emission axis is a real, filterable choice rather than a check that always
 * runs regardless of what a caller asked for.
 */
export const ALL_AXES = [...ORACLE_AXES, EMISSION_AXIS] as const;
export type AnyAxis = (typeof ALL_AXES)[number];

/**
 * Thrown by `runOracle`/`runOracleSuite` when `axes` is given but empty. An
 * empty array is a real selection of nothing, and silently producing zero
 * verdicts for it would read as a clean, fully-considered run.
 */
export class EmptyAxisSelectionError extends Error {
  constructor() {
    super(
      'runOracle/runOracleSuite: `axes` was given as an empty array — that selects ' +
        'nothing to check. Pass at least one axis, or omit `axes` to run the default set.',
    );
    this.name = 'EmptyAxisSelectionError';
  }
}

/** Resolves `opts.axes` into the axes to run, rejecting an explicit empty selection. */
function resolveAxisSelection(opts: RunOracleOptions): {
  readonly wanted: ReadonlySet<AnyAxis>;
  readonly selectedAxes: readonly AnyAxis[];
} {
  if (opts.axes !== undefined && opts.axes.length === 0) {
    throw new EmptyAxisSelectionError();
  }
  const wanted = new Set<AnyAxis>(opts.axes ?? ALL_AXES);
  return { wanted, selectedAxes: ALL_AXES.filter((axis) => wanted.has(axis)) };
}

export interface EmissionAxisVerdict {
  readonly axis: EmissionAxis;
  readonly actionId: string;
  readonly status: AxisStatus;
  readonly diagnostic: string;
}

/** The distinct event names declared under one condition, sorted. */
function emissionEvents(
  declared: readonly DeclaredEmission[],
  condition: DeclaredEmission['condition'],
): readonly string[] {
  return [
    ...new Set(declared.filter((e) => e.condition === condition).map((e) => e.event)),
  ].sort(byString);
}

/**
 * DECLARED EMISSION. A handler declaring an emission it does not perform.
 * Evidence is an OBSERVED append — the emission recorder minted and injected
 * into the observation context the exact way {@link EffectRecorder} is — never
 * a re-read of {@link ContractDeclaration.declaredEmissions}, which would be
 * tautological.
 *
 * The verdict follows the SAME `{event, condition}` semantics the dispatch
 * emission verifier reaches over the same declarations: only `always` edges
 * are required, so only an `always` edge can produce a `fail`. A `conditional`
 * edge that did not fire is the branch not being taken, not a defect — but one
 * that DID fire is positive observed evidence, and is enough to reach `pass`
 * on its own.
 *
 * `not-observed` whenever nothing was required and nothing was seen: there is
 * no evidence either way, and reporting `pass` would claim positive evidence
 * this axis never collected (see the module header's `not-observed` is NOT
 * `pass`).
 */
export function checkDeclaredEmission(
  decl: ContractDeclaration,
  obs: Observation,
): EmissionAxisVerdict {
  const axis = EMISSION_AXIS;
  const actionId = decl.actionId;
  const declared = decl.declaredEmissions ?? [];
  const required = emissionEvents(declared, 'always');
  const conditional = emissionEvents(declared, 'conditional');
  const appended = new Set(obs.performedEmissions.map((e) => e.eventType));
  const corroborated = conditional.filter((event) => appended.has(event));
  const observedList = [...appended].sort(byString).join(', ') || 'none';

  if (declared.length === 0) {
    return {
      axis,
      actionId,
      status: 'not-observed',
      diagnostic: 'contract declares no emission — nothing to observe as appended',
    };
  }
  if (required.length === 0 && corroborated.length === 0) {
    return {
      axis,
      actionId,
      status: 'not-observed',
      diagnostic:
        `contract declares only conditional emission(s) [${conditional.join(', ')}] and none was ` +
        `observed appended — a conditional edge that did not fire is not a fault, and its ` +
        `absence is not evidence either (observed appends {${observedList}})`,
    };
  }
  const missing = required.filter((event) => !appended.has(event));
  if (missing.length > 0) {
    return {
      axis,
      actionId,
      status: 'fail',
      diagnostic:
        `handler declares unconditional emission(s) [${missing.join(', ')}] but no append was ` +
        `observed at runtime — required {${required.join(', ') || 'none'}}; ` +
        `observed appends {${observedList}}`,
    };
  }
  const corroboration =
    corroborated.length > 0 ? `; conditional edge(s) observed [${corroborated.join(', ')}]` : '';
  if (required.length === 0) {
    return {
      axis,
      actionId,
      status: 'pass',
      diagnostic:
        `no unconditional emission is declared, and conditional emission(s) ` +
        `[${corroborated.join(', ')}] were observed appended`,
    };
  }
  return {
    axis,
    actionId,
    status: 'pass',
    diagnostic:
      `every unconditional emission was observed appended ` +
      `(required {${required.join(', ')}})${corroboration}`,
  };
}

// ─── The oracle run ──────────────────────────────────────────────────────────

export interface OracleReport {
  readonly actionId: string;
  /**
   * True when no axis returned `fail`. A report that never looked is still
   * `ok` — that is "no break was found", not "we inspected the subject".
   * {@link clean} is the determinate-count half.
   */
  readonly ok: boolean;
  /**
   * True only when some axis reached a verdict AND none failed. A report
   * of only `not-observed` is never clean: absence of observation is not
   * assurance.
   */
  readonly clean: boolean;
  readonly verdicts: readonly AxisVerdict[];
  /**
   * The emission axis's verdict, reported separately — see
   * {@link EmissionAxisVerdict}. `undefined` when `declared-emission` was not
   * among {@link selectedAxes}: an axis that did not run reports no verdict,
   * rather than a stale or synthesized one.
   */
  readonly emissionVerdict: EmissionAxisVerdict | undefined;
  /** The axes this report actually ran, in {@link ALL_AXES} order. */
  readonly selectedAxes: readonly AnyAxis[];
}

/**
 * A report on which the emission axis ran — narrows {@link OracleReport.emissionVerdict}
 * to defined. Use this instead of an `!== undefined` check at each call site so the
 * exclusion of a standard-only report from an emission census is enforced by the
 * type checker, not by remembering to filter correctly by hand.
 */
export interface EmissionSelectedReport extends OracleReport {
  readonly emissionVerdict: EmissionAxisVerdict;
}

/** True iff `declared-emission` was selected on this report's run. */
export function emissionWasSelected(report: OracleReport): report is EmissionSelectedReport {
  return report.emissionVerdict !== undefined;
}

export interface RunOracleOptions {
  /**
   * Restrict the run to a subset of the six {@link ALL_AXES} (default: all
   * six). An explicit empty array is rejected — see {@link EmptyAxisSelectionError}.
   */
  readonly axes?: readonly AnyAxis[];
}

/**
 * Run the oracle over one subject: observe its behavior, then compare each
 * selected axis' independently-derived expectation against the observation.
 * `ok` is false iff any SELECTED axis returns `fail`.
 */
export async function runOracle(
  subject: OracleSubject,
  opts: RunOracleOptions = {},
): Promise<OracleReport> {
  const { wanted, selectedAxes } = resolveAxisSelection(opts);
  const obs = await observeBehavior(subject);
  const decl = subject.declaration;
  const all: AxisVerdict[] = [
    checkIncorrectHandler(decl, obs),
    checkMissingAuthorization(decl, obs),
    checkUndeclaredEffect(decl, obs),
    checkMalformedOutput(decl, obs),
    checkCompatibilityBreak(subject, obs),
  ];
  const verdicts = all.filter((v) => wanted.has(v.axis));
  const emissionVerdict = wanted.has(EMISSION_AXIS) ? checkDeclaredEmission(decl, obs) : undefined;
  const considered = emissionVerdict ? [...verdicts, emissionVerdict] : verdicts;
  const ok = considered.every((v) => v.status !== 'fail');
  return {
    actionId: decl.actionId,
    ok,
    clean: observationIsClean(considered),
    verdicts,
    emissionVerdict,
    selectedAxes,
  };
}

export interface OracleSuiteReport {
  /**
   * True when no subject returned `fail`. A suite that never looked is still
   * `ok` so a vacuous live run can be told from a broken one. {@link clean}
   * is the determinate-count half.
   */
  readonly ok: boolean;
  /**
   * True only when some axis reached a verdict AND none failed. A suite of
   * only `not-observed` verdicts is never clean: a determinate count of
   * zero is not assurance.
   */
  readonly clean: boolean;
  readonly reports: readonly OracleReport[];
  /**
   * Every failing verdict across the suite, for a single-glance diagnostic.
   * Includes emission-axis failures alongside the five {@link ORACLE_AXES}.
   */
  readonly failures: readonly (AxisVerdict | EmissionAxisVerdict)[];
  /**
   * Per-axis observation census. Makes VACUITY visible: an axis whose
   * `observed` count is 0 across the whole suite reported nothing at all, which
   * `ok: true` alone would happily conceal.
   */
  readonly coverage: readonly AxisCoverage[];
  /** The axes this suite actually ran, in {@link ALL_AXES} order — same value every report in `reports` carries. */
  readonly selectedAxes: readonly AnyAxis[];
}

/** How often one axis actually reached a verdict across a set of reports. */
export interface AxisCoverage {
  readonly axis: OracleAxis;
  readonly pass: number;
  readonly fail: number;
  readonly notObserved: number;
  /** `pass + fail` — the number of subjects on which the axis genuinely looked. */
  readonly observed: number;
}

/**
 * Census each axis across `reports`. `not-observed` is counted separately from
 * `pass` precisely so "we did not look" can never be mistaken for "we looked
 * and it was fine" when reading a green suite.
 */
export function axisCoverage(reports: readonly OracleReport[]): readonly AxisCoverage[] {
  return ORACLE_AXES.map((axis) => {
    let pass = 0;
    let fail = 0;
    let notObserved = 0;
    for (const report of reports) {
      for (const verdict of report.verdicts) {
        if (verdict.axis !== axis) continue;
        if (verdict.status === 'pass') pass += 1;
        else if (verdict.status === 'fail') fail += 1;
        else notObserved += 1;
      }
    }
    return { axis, pass, fail, notObserved, observed: pass + fail };
  });
}

/** A determinate count of zero is never a clean bill — only a reached verdict can be. */
function observationIsClean(verdicts: readonly { readonly status: AxisStatus }[]): boolean {
  let determinate = 0;
  let failed = 0;
  for (const verdict of verdicts) {
    if (verdict.status === 'not-observed') continue;
    determinate += 1;
    if (verdict.status === 'fail') failed += 1;
  }
  return determinate > 0 && failed === 0;
}

/** Run the oracle over many subjects. `ok` iff no subject failed; `clean` iff something was observed and nothing failed. */
export async function runOracleSuite(
  subjects: readonly OracleSubject[],
  opts: RunOracleOptions = {},
): Promise<OracleSuiteReport> {
  // Resolved (and any empty-selection error raised) before any subject is
  // observed, so a rejected call never runs a single check.
  const { selectedAxes } = resolveAxisSelection(opts);
  const reports = await Promise.all(subjects.map((s) => runOracle(s, opts)));
  const failures: (AxisVerdict | EmissionAxisVerdict)[] = reports.flatMap((r) => [
    ...r.verdicts.filter((v) => v.status === 'fail'),
    ...(r.emissionVerdict?.status === 'fail' ? [r.emissionVerdict] : []),
  ]);
  const considered = reports.flatMap<AxisVerdict | EmissionAxisVerdict>((r) =>
    r.emissionVerdict ? [...r.verdicts, r.emissionVerdict] : r.verdicts,
  );
  return {
    ok: failures.length === 0,
    clean: observationIsClean(considered),
    reports,
    failures,
    coverage: axisCoverage(reports),
    selectedAxes,
  };
}

/** The single failing verdict for `axis` in a report, or undefined. */
export function failureFor(report: OracleReport, axis: OracleAxis): AxisVerdict | undefined {
  return report.verdicts.find((v) => v.axis === axis && v.status === 'fail');
}

/** The verdict for `axis` in a report, whatever its status. */
export function verdictFor(report: OracleReport, axis: OracleAxis): AxisVerdict | undefined {
  return report.verdicts.find((v) => v.axis === axis);
}

/** A deterministic one-line-per-axis summary of a report, emission axis included. */
export function summarizeReport(report: OracleReport): string {
  const head = `${report.actionId} — ${report.ok ? 'PASS' : 'FAIL'}`;
  const all = report.emissionVerdict ? [...report.verdicts, report.emissionVerdict] : report.verdicts;
  const lines = all.map((v) => `  [${v.status}] ${v.axis}: ${v.diagnostic}`);
  return [head, ...lines].join('\n');
}

// ─── Generation-consistency model (the independence proof's foil) ────────────
//
// A FAITHFUL model of the generation route: the projection the compiler applies
// (registry → descriptor with content-addressed digest over policy + schemas)
// — reusing the SAME `zodToJsonSchema` / `canonicalJson` / `digestText`
// building blocks `compiler/descriptors.ts` uses. Critically it is a PURE
// FUNCTION OF THE DECLARATION: no behavior enters. So for a seeded break — where
// the declaration is byte-identical and only the handler misbehaves — this
// produces a byte-identical descriptor for the broken and the correct subject.
// That is the blind spot every generation/drift guard shares, made concrete.

export interface GeneratedDescriptor {
  readonly actionId: string;
  readonly surfaceVersion: string;
  readonly policy: {
    readonly safety: ActionSafety;
    readonly readOnly: boolean;
    readonly idempotent: boolean;
    readonly requiredRoles: readonly string[];
    readonly declaredEffects: readonly string[];
  };
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly errorCodes: readonly string[];
  readonly outputKinds: readonly string[];
  /** `sha256:` content address over the descriptor body (excludes itself). */
  readonly digest: string;
}

function declaredErrorCodes(): readonly string[] {
  // The declaration-derived error surface (the layers every action is bound
  // to). A pure function of the contract surface — mirrors `meta-model.ts`
  // `deriveErrorCodes` minus the behavioral task binding it cannot see.
  return [
    ...layerCodes('protocol'),
    ...layerCodes('authorization'),
    ...layerCodes('handler'),
    ...layerCodes('output'),
    ...layerCodes('presenter'),
  ]
    .filter((c, i, arr) => arr.indexOf(c) === i)
    .sort(byString);
}

/**
 * Project a declaration to its generated runtime descriptor — the artifact a
 * generation/drift guard would compare. A pure function of the DECLARATION.
 */
export function deriveGeneratedDescriptor(decl: ContractDeclaration): GeneratedDescriptor {
  const body = {
    actionId: decl.actionId,
    surfaceVersion: decl.surfaceVersion,
    policy: {
      safety: decl.safety,
      readOnly: decl.readOnly,
      idempotent: decl.idempotent,
      requiredRoles: [...decl.requiredRoles].sort(byString),
      declaredEffects: [...decl.declaredEffects].map((e) => String(e)).sort(byString),
    },
    inputSchema: zodToJsonSchema(decl.inputSchema),
    outputSchema: zodToJsonSchema(decl.outputSchema),
    errorCodes: declaredErrorCodes(),
    outputKinds: [...OUTPUT_KINDS].sort(byString),
  };
  return { ...body, digest: digestText(canonicalJson(body)) };
}

/** The canonical, byte-stable serialization of a generated descriptor. */
export function serializeGeneratedDescriptor(descriptor: GeneratedDescriptor): string {
  return canonicalJson(descriptor);
}

export interface GenerationConsistencyResult {
  readonly ok: boolean;
  readonly digest: string;
  readonly serialized: string;
}

/**
 * Model a generation/drift guard: re-derive the descriptor from the declaration
 * twice and confirm the artifact is byte-stable (the "generated files all
 * agree" green light). Behavior is invisible to it by construction.
 */
export function checkGenerationConsistency(
  decl: ContractDeclaration,
): GenerationConsistencyResult {
  const first = deriveGeneratedDescriptor(decl);
  const a = serializeGeneratedDescriptor(first);
  const b = serializeGeneratedDescriptor(deriveGeneratedDescriptor(decl));
  return { ok: a === b, digest: first.digest, serialized: a };
}
