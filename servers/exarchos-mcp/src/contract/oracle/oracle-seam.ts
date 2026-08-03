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
// This module is a TEST-INVOKED source-lint gate (the `-seam.ts` convention):
// its co-located test runs `runOracleSuite()` against the real registry and
// against the seeded-break fixtures. It exports pure analysis functions; it is
// not a production import target.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { canonicalJson } from '../request-context.js';
import { digestText } from '../authority-digest.js';
import { zodToJsonSchema } from '../../adapters/json-schema.js';
import { layerCodes } from '../error-families.js';
import { OUTPUT_KINDS } from '../envelope.js';
import { classifyVersionChange, type CompatibilityClass } from '../compatibility.js';
import { detectModuleEffects, type EffectClass } from '../../architecture/effect-ledger.js';

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

/** The caller identity/authorization the oracle presents to a handler. */
export interface Caller {
  readonly subjectId: string;
  readonly roles: readonly string[];
}

/** The context an observed handler runs against. */
export interface ObservationContext {
  readonly caller: Caller;
  readonly effects: EffectRecorder;
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

/** Throw {@link UnauthorizedError} unless the caller holds every required role. */
export function guardRoles(ctx: ObservationContext, requiredRoles: readonly string[]): void {
  if (requiredRoles.length === 0) return;
  const held = new Set(ctx.caller.roles);
  // `any` is the registry's open-role marker: any authenticated caller holds it.
  const authorized = requiredRoles.some((role) => role === 'any' || held.has(role));
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

/** A subject the oracle can observe: a declared contract plus real behavior. */
export interface OracleSubject {
  readonly declaration: ContractDeclaration;
  readonly handler: ObservableHandler;
  /** The probe input the oracle feeds the handler. */
  readonly probeInput: unknown;
  /** Enables the compatibility axis: the recorded prior-version observation. */
  readonly compatBaseline?: CompatBaseline;
  /**
   * Optional handler source for the COMPLEMENTARY static effect scan (P04-01).
   * Runtime effect recording is the primary signal; this cross-checks it.
   */
  readonly handlerSource?: string;
}

// ─── Observation ─────────────────────────────────────────────────────────────

export interface Observation {
  readonly output: unknown;
  readonly outputRepeat: unknown;
  readonly performedEffects: readonly EffectEvent[];
  readonly staticEffects: readonly EffectClass[];
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
 * Observe the subject's actual behavior: invoke the handler against the probe
 * (twice, for idempotency), watch the effects it performs, and probe it with an
 * unauthorized caller. Pure observation — no comparison to the contract yet.
 */
export async function observeBehavior(subject: OracleSubject): Promise<Observation> {
  const { handler, probeInput, declaration } = subject;
  const authorizedRoles = declaration.requiredRoles.length > 0
    ? [...declaration.requiredRoles]
    : ['any'];

  // Authorized invocation #1 — the observed output + performed effects.
  const rec1 = createEffectRecorder();
  let output: unknown;
  let invocationError: string | undefined;
  try {
    output = await handler(probeInput, {
      caller: { subjectId: 'oracle-authorized', roles: authorizedRoles },
      effects: rec1,
    });
  } catch (err) {
    invocationError = errorMessage(err);
  }

  // Authorized invocation #2 — the idempotency witness (fresh recorder).
  const rec2 = createEffectRecorder();
  let outputRepeat: unknown;
  if (invocationError === undefined) {
    try {
      outputRepeat = await handler(probeInput, {
        caller: { subjectId: 'oracle-authorized', roles: authorizedRoles },
        effects: rec2,
      });
    } catch (err) {
      // A handler that succeeds once then throws is itself a contradiction.
      invocationError = `second invocation diverged by throwing: ${errorMessage(err)}`;
    }
  }

  // Unauthorized probe — a caller holding NO roles.
  const rec3 = createEffectRecorder();
  let unauthorizedRefused = false;
  let unauthorizedDetail = '';
  {
    let value: unknown;
    let error: unknown;
    try {
      value = await handler(probeInput, {
        caller: { subjectId: 'oracle-intruder', roles: [] },
        effects: rec3,
      });
    } catch (err) {
      error = err;
    }
    unauthorizedRefused = isRefusal(value, error);
    unauthorizedDetail = error !== undefined ? `refused: ${errorMessage(error)}` : 'returned a value';
  }

  const staticEffects = subject.handlerSource !== undefined
    ? detectModuleEffects(declaration.actionId, subject.handlerSource).map((e) => e.effectClass)
    : [];

  return {
    output,
    outputRepeat,
    performedEffects: rec1.performed,
    staticEffects,
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
  const a = canonicalJson(obs.output);
  const b = canonicalJson(obs.outputRepeat);
  if (a !== b) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'fail',
      diagnostic:
        `handler is declared idempotent but two identical-input invocations diverged: ` +
        `${a} vs ${b}`,
    };
  }
  return {
    axis,
    actionId: decl.actionId,
    status: 'pass',
    diagnostic: 'idempotent as declared; identical-input invocations agree',
  };
}

/**
 * Axis 2 — MISSING AUTHORIZATION. A declared authorization requirement that is
 * not actually enforced at runtime. Observed by probing with an unauthorized
 * caller and checking the handler refuses.
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
  if (obs.unauthorizedRefused) {
    return {
      axis,
      actionId: decl.actionId,
      status: 'pass',
      diagnostic:
        `declared requirement {${decl.requiredRoles.join(', ')}} is enforced ` +
        `(unauthorized caller ${obs.unauthorizedDetail})`,
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
 */
export function checkUndeclaredEffect(
  decl: ContractDeclaration,
  obs: Observation,
): AxisVerdict {
  const axis: OracleAxis = 'undeclared-effect';
  const declared = new Set<EffectClass>(decl.declaredEffects);

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

// ─── The oracle run ──────────────────────────────────────────────────────────

export interface OracleReport {
  readonly actionId: string;
  readonly ok: boolean;
  readonly verdicts: readonly AxisVerdict[];
}

export interface RunOracleOptions {
  /** Restrict the run to a subset of axes (default: all five). */
  readonly axes?: readonly OracleAxis[];
}

/**
 * Run the oracle over one subject: observe its behavior, then compare each axis'
 * independently-derived expectation against the observation. `ok` is false iff
 * any axis returns `fail`.
 */
export async function runOracle(
  subject: OracleSubject,
  opts: RunOracleOptions = {},
): Promise<OracleReport> {
  const obs = await observeBehavior(subject);
  const decl = subject.declaration;
  const all: AxisVerdict[] = [
    checkIncorrectHandler(decl, obs),
    checkMissingAuthorization(decl, obs),
    checkUndeclaredEffect(decl, obs),
    checkMalformedOutput(decl, obs),
    checkCompatibilityBreak(subject, obs),
  ];
  const wanted = opts.axes ? new Set<OracleAxis>(opts.axes) : undefined;
  const verdicts = wanted ? all.filter((v) => wanted.has(v.axis)) : all;
  const ok = verdicts.every((v) => v.status !== 'fail');
  return { actionId: decl.actionId, ok, verdicts };
}

export interface OracleSuiteReport {
  readonly ok: boolean;
  readonly reports: readonly OracleReport[];
  /** Every failing verdict across the suite, for a single-glance diagnostic. */
  readonly failures: readonly AxisVerdict[];
}

/** Run the oracle over many subjects. `ok` iff every subject is `ok`. */
export async function runOracleSuite(
  subjects: readonly OracleSubject[],
  opts: RunOracleOptions = {},
): Promise<OracleSuiteReport> {
  const reports = await Promise.all(subjects.map((s) => runOracle(s, opts)));
  const failures = reports.flatMap((r) => r.verdicts.filter((v) => v.status === 'fail'));
  return { ok: failures.length === 0, reports, failures };
}

/** The single failing verdict for `axis` in a report, or undefined. */
export function failureFor(report: OracleReport, axis: OracleAxis): AxisVerdict | undefined {
  return report.verdicts.find((v) => v.axis === axis && v.status === 'fail');
}

/** A deterministic one-line-per-axis summary of a report. */
export function summarizeReport(report: OracleReport): string {
  const head = `${report.actionId} — ${report.ok ? 'PASS' : 'FAIL'}`;
  const lines = report.verdicts.map(
    (v) => `  [${v.status}] ${v.axis}: ${v.diagnostic}`,
  );
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
