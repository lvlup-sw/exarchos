/**
 * The oracle that judges handler behavior against the contract. It catches a wrong handler, a
 * missing authorization check, an undeclared effect, a malformed output, and a compatibility
 * break, even when the generated files agree.
 *
 * Each generation guard compares one declaration with another declaration from the same source.
 * Thus a wrong meta-model or a misbehaving handler is invisible to them. This oracle does not
 * call `deriveMetaModel()` or `compile()`, and it does not read `generated/proof-fixtures.json`.
 * It derives expectations from the declared contract and judges the observed handler behavior.
 *
 * Each axis has three outcomes: `pass`, `fail`, and `not-observed`. An axis reports `pass` only
 * with positive evidence. {@link axisCoverage} shows each axis that observed nothing.
 * The test of this module runs `runOracleSuite()` on the real registry and the seeded breaks.
 */

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
 * One event that a contract declares a handler appends, in the `{event, condition}` form of the
 * registry. An `always` edge is promised on each call, so its absence is a fault. A
 * `conditional` edge fires only on one branch, so its absence is never a fault.
 */
export interface DeclaredEmission {
  readonly event: string;
  readonly condition: 'always' | 'conditional';
}

/**
 * What a contract declares about one action. The oracle reads it directly, not through the
 * meta-model of the compiler, and derives the expectation of each axis from it.
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
  /** The effect classes that the contract lets this handler perform. */
  readonly declaredEffects: readonly EffectClass[];
  /**
   * The events that the contract declares this handler appends. A subject whose observed
   * function is not the handler of the action declares none. Then the emission axis reports `not-observed`.
   */
  readonly declaredEmissions?: readonly DeclaredEmission[];
  /** The declared input schema. */
  readonly inputSchema: z.ZodType;
  /** The declared output schema (the value a handler returns must satisfy it). */
  readonly outputSchema: z.ZodType;
  /** The current declared contract-surface version (for the compatibility axis). */
  readonly surfaceVersion: string;
}

/** One effect the handler actually performed, as recorded at runtime. */
export interface EffectEvent {
  readonly effectClass: EffectClass;
  readonly evidence: string;
}

/**
 * A runtime effect recorder in the observation context. A handler calls `record()` when it
 * performs an effect. This signal is independent of the static effect ledger, which sees only imports.
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
 * A runtime emission recorder in the observation context, made the same way as
 * {@link EffectRecorder}. A handler calls `record()` when it commits an append, so the
 * evidence is an observed append and not the declaration.
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
   * The emission recorder. It is optional so that a context literal built outside the oracle
   * compiles. {@link observeBehavior} always supplies one.
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

/** The stable authorization codes that a refusal can carry. */
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
 * The open-role marker of the registry. Each authenticated caller holds it, so it states no
 * restrictive requirement. See {@link checkMissingAuthorization}.
 */
export const OPEN_ROLE_MARKER = 'any';

/**
 * Throws {@link UnauthorizedError} unless the caller holds one of the required roles. A required
 * {@link OPEN_ROLE_MARKER} admits each caller.
 */
export function guardRoles(ctx: ObservationContext, requiredRoles: readonly string[]): void {
  if (requiredRoles.length === 0) return;
  const held = new Set(ctx.caller.roles);
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
 * How the synthetic {@link Caller} reaches the real authorization surface of the handler. With
 * `observation-context`, the handler reads `ctx.caller`. With `dispatch-authority`, an adapter
 * puts the caller on the authorization snapshot of the dispatch scope before the call.
 * Without a surface, the authorization axis reports `not-observed`.
 */
export type AuthorizationSurface = 'observation-context' | 'dispatch-authority';

/**
 * The two shapes of a per-call carrier. The oracle checks the observed values against the kind
 * before it honors the mask. A `measurement-block` is an object of numbers, such as `_perf`.
 * A `generation-timestamp` is an ISO-8601 instant.
 */
export type VolatileCarrierKind = 'measurement-block' | 'generation-timestamp';

/** A dot-path into the output that carries per-call runtime bookkeeping. */
export interface VolatileCarrier {
  /** The dot-path, for example `_perf` or `data.session.start`. */
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
   * Per-call carriers to leave out of the idempotency comparison only. Schema validation and
   * the compatibility comparison still see them.
   *
   * The oracle honors a carrier only when both observed values match its kind. Otherwise it
   * refuses the mask, keeps the value in the comparison, and names the path in the diagnostic.
   */
  readonly volatileCarriers?: readonly VolatileCarrier[];
  /**
   * The handler source and its lexer, for the static effect scan that cross-checks the runtime
   * record. They are one field, so a caller cannot supply the source without the lexer.
   * No caller sets this field at this time, so `staticEffects` is always empty.
   */
  readonly handlerSource?: {
    readonly source: string;
    readonly lex: ModuleLexer;
  };
}

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
  /** Whether the subject has an authorization surface that the oracle can probe. */
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

/** True when the handler declined: it threw any error, or it returned a `success:false` envelope. */
function isRefusal(value: unknown, error: unknown): boolean {
  if (error !== undefined) {
    if (error instanceof UnauthorizedError) return true;
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && AUTHORIZATION_CODES.has(code)) return true;
    }
    return true;
  }
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
 * True when both observed values match the declared carrier kind. Thus
 * `{ path: 'data', kind: 'generation-timestamp' }` over a real payload masks nothing.
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
 * Removes the honored carriers from both outputs for the idempotency comparison. A carrier with
 * the wrong shape is refused and reported. An absent carrier is skipped.
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
    if (!a.found || !b.found) continue;
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
 * Observes the behavior of the subject. It calls the handler twice as an authorized caller, each
 * time with fresh recorders, and once as a caller with no roles. It does not compare with the contract.
 *
 * A throw on the second call is a contradiction. A throw on the authorized call counts as not
 * served here, and the incorrect-handler axis reports it.
 */
export async function observeBehavior(subject: OracleSubject): Promise<Observation> {
  const { handler, probeInput, declaration } = subject;
  const authorizedRoles = declaration.requiredRoles.length > 0
    ? [...declaration.requiredRoles]
    : [OPEN_ROLE_MARKER];

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
      invocationError = `second invocation diverged by throwing: ${errorMessage(err)}`;
    }
  }

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
    authorizedRefused: invocationError !== undefined || isRefusal(output, undefined),
    unauthorizedRefused,
    unauthorizedDetail,
    ...(invocationError !== undefined ? { invocationError } : {}),
  };
}

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
 * Axis 2, missing authorization: a declared role requirement that the runtime does not enforce.
 * A `pass` needs the handler to serve the authorized caller and refuse the unauthorized caller.
 *
 * The verdict is `not-observed` for an empty or open-marker role set. It is also `not-observed`
 * without an {@link AuthorizationSurface}, and when the handler refuses the authorized caller too.
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
 * Axis 3, undeclared effect: a handler that performs an effect its contract does not declare.
 * The runtime recorder is the primary signal, and the static import scan cross-checks it.
 * With no evidence the verdict is `not-observed`, because an empty recorder can also mean no instrumentation.
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
 * Axis 5, compatibility break: the output dropped a field of the prior-version observation, but
 * `classifyVersionChange` does not classify the declared version change as breaking.
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

/**
 * The emission axis. It is in {@link ALL_AXES} but not in {@link ORACLE_AXES}, because
 * `AXIS_HANDLERS` in `fixtures.ts` has a seeded break for each member of `ORACLE_AXES`. The
 * report carries it on {@link OracleReport.emissionVerdict}, and it counts toward `ok` and `failures`.
 */
export const EMISSION_AXIS = 'declared-emission';
export type EmissionAxis = typeof EMISSION_AXIS;

/**
 * All the axes that a caller can select: {@link ORACLE_AXES} and the emission axis.
 * `RunOracleOptions.axes` selects from this list, so a caller can also leave out the emission axis.
 */
export const ALL_AXES = [...ORACLE_AXES, EMISSION_AXIS] as const;
export type AnyAxis = (typeof ALL_AXES)[number];

/**
 * Thrown by `runOracle` and `runOracleSuite` when `axes` is an empty array. A run with zero
 * verdicts looks like a clean run, so the oracle refuses it.
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
 * The emission axis: a handler that declares an emission it does not perform. The evidence is an
 * observed append in the emission recorder, not the declaration.
 *
 * Only a missing `always` edge gives `fail`. A `conditional` edge that fired is enough for `pass`.
 * When no edge is required and none fired, the verdict is `not-observed`.
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
 * A report on which the emission axis ran, so {@link OracleReport.emissionVerdict} is defined.
 * With this type, the type checker keeps a report without that axis out of an emission census.
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
   * The observation census of each axis. An axis with an `observed` count of 0 reported nothing,
   * and `ok: true` alone hides that.
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

/**
 * Runs the oracle over many subjects. `ok` is true when no subject failed. `clean` is true when
 * an axis reached a verdict and none failed. An empty `axes` selection throws before any check runs.
 */
export async function runOracleSuite(
  subjects: readonly OracleSubject[],
  opts: RunOracleOptions = {},
): Promise<OracleSuiteReport> {
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

/**
 * A model of the descriptor that the generation route makes. It uses the same building blocks as
 * `compiler/descriptors.ts` and is a pure function of the declaration. Thus a seeded break gives
 * the same descriptor for the broken subject and the correct subject.
 */
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

/**
 * The error codes of the layers that each action is bound to. It is like `deriveErrorCodes` in
 * `meta-model.ts`, without the task binding.
 */
function declaredErrorCodes(): readonly string[] {
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

/** Projects a declaration to its generated descriptor, the artifact that a drift guard compares. */
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
