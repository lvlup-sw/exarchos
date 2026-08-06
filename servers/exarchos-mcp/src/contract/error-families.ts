// ─── Total failure-origin families + stable error/exit registry (P03-02) ─────
//
// PROGRAM-03, API-006. Defines the CLOSED, enumerated mapping from every
// failure ORIGIN to a stable contract error code and a stable CLI exit code.
// "Total" is the operative word: every failure in every layer — protocol,
// authorization, task, handler, output, presenter — maps to exactly one stable
// contract error and one CLI exit. No failure may fall through to an unmapped
// generic case.
//
// ## The six failure layers
//
//   protocol       transport / JSON-RPC / method / version / schema admission
//   authorization  principal + capability + reserved-event + idempotency-scope
//   task            durable Task identity / ownership / lease / cancellation
//   handler         the action handler's own decision (business failure)
//   output          the handler's result violates its declared output contract
//   presenter       the presentation projection (CLI/MCP render) failed
//
// ## Totality (two independent compile-time proofs + one runtime proof)
//
//   1. `FAMILY_DEFAULTS: Record<FailureLayer, …>` — a `Record` keyed by the
//      finite union REQUIRES every layer as a property. Adding a 7th
//      `FailureLayer` without a family descriptor is a COMPILE error (TS2741
//      missing property). This is the primary "an unmapped family cannot
//      exist" proof.
//   2. `layerSeverity` switches over the layer union with an `assertNever`
//      default (a `never` assertion over the family union, as mandated). A new
//      unmapped layer makes the default arm's `layer` non-`never`, so
//      `assertNever(layer)` fails to compile (TS2345).
//   3. `assertNever` throws at runtime if control ever reaches it via an
//      unsound cast — the belt to the compile-time braces.
//
// This module is PURE (no I/O, no clock) so the mapping is unit-testable in
// isolation and safe to digest as a frozen contract authority (see
// `contract-surface.ts` → the `contract-surface` pin in `authority-pin.ts`).
// ────────────────────────────────────────────────────────────────────────────

// ─── The totality primitive ─────────────────────────────────────────────────

/**
 * Compile-time exhaustiveness guard. In a `switch`/`if` chain that has
 * narrowed a union to nothing, the residual value has type `never`; passing it
 * here type-checks. If a new union member is added without a handling arm the
 * residual is that member (not `never`) and this call fails to compile
 * (TS2345). At runtime it throws — an unsound cast that reaches it is loud, not
 * silent.
 */
export function assertNever(value: never, context = 'value'): never {
  throw new Error(`Non-exhaustive ${context}: ${JSON.stringify(value)}`);
}

// ─── Failure-origin layers ──────────────────────────────────────────────────

/**
 * The six failure ORIGINS, in pipeline order. This union is the axis over which
 * totality is proven — every member maps to a stable code + CLI exit.
 */
export const FAILURE_LAYERS = [
  'protocol',
  'authorization',
  'task',
  'handler',
  'output',
  'presenter',
] as const;

export type FailureLayer = (typeof FAILURE_LAYERS)[number];

// ─── Stable CLI exit-code table (contract authority) ────────────────────────

/**
 * Canonical CLI exit codes. This is the CONTRACT authority for exit behavior;
 * `adapters/cli.ts`'s `CLI_EXIT_CODES` + `ERROR_CODE_EXIT_CODES` are a faithful
 * projection of this table (proven by `error-families.test.ts`) until P03-05
 * generates the CLI directly from this contract.
 *
 * The 0–3 band is the generic success/input/handler/uncaught spine; the
 * 17/18 band carries the two bounded-`wait` outcomes, kept above the spine so
 * they never alias it.
 */
export const CONTRACT_EXIT_CODES = {
  SUCCESS: 0,
  INVALID_INPUT: 1,
  HANDLER_ERROR: 2,
  UNCAUGHT_EXCEPTION: 3,
  WAIT_TIMEOUT: 17,
  WAIT_FAILED: 18,
} as const;

export type ContractExitCode = (typeof CONTRACT_EXIT_CODES)[keyof typeof CONTRACT_EXIT_CODES];

// ─── Retry policy ───────────────────────────────────────────────────────────

/**
 * How a caller should react to a failure code.
 *
 * - `none`           — the request cannot succeed as-is; do not retry.
 * - `after-backoff`  — retry the SAME request after a delay (transient
 *                      contention, e.g. `STORAGE_BUSY`).
 * - `after-refetch`  — re-read state and re-decide before retrying; the prior
 *                      read is stale (e.g. `CONCURRENCY_CONFLICT`).
 */
export type RetryPolicy = 'none' | 'after-backoff' | 'after-refetch';

// ─── Family descriptor ──────────────────────────────────────────────────────

export interface FailureFamilyDescriptor {
  readonly layer: FailureLayer;
  /** The family's DEFAULT stable contract error code. */
  readonly code: string;
  /** The family's DEFAULT stable CLI exit code. */
  readonly exitCode: ContractExitCode;
  readonly retry: RetryPolicy;
  readonly description: string;
}

/**
 * The TOTAL family map. `Record<FailureLayer, …>` forces every layer to be
 * present — the primary compile-time totality proof (see file header §1).
 */
export const FAMILY_DEFAULTS: Readonly<Record<FailureLayer, FailureFamilyDescriptor>> = {
  protocol: {
    layer: 'protocol',
    code: 'PROTOCOL_ERROR',
    exitCode: CONTRACT_EXIT_CODES.INVALID_INPUT,
    retry: 'none',
    description:
      'Transport, JSON-RPC, method/action, version, or input-schema admission ' +
      'failed — the request is malformed or unsupported.',
  },
  authorization: {
    layer: 'authorization',
    code: 'AUTHORIZATION_DENIED',
    exitCode: CONTRACT_EXIT_CODES.HANDLER_ERROR,
    retry: 'none',
    description:
      'The authenticated principal lacks the capability/posture required for ' +
      'the action, or attempted a reserved/idempotency-scoped operation.',
  },
  task: {
    layer: 'task',
    code: 'TASK_FAILED',
    exitCode: CONTRACT_EXIT_CODES.HANDLER_ERROR,
    retry: 'after-backoff',
    description:
      'A durable Task failed on identity, ownership, lease/fencing, ' +
      'cancellation, or bounded-wait semantics.',
  },
  handler: {
    layer: 'handler',
    code: 'HANDLER_ERROR',
    exitCode: CONTRACT_EXIT_CODES.HANDLER_ERROR,
    retry: 'none',
    description:
      "The action handler's own decision failed (a business-rule failure or an " +
      'unexpected internal error).',
  },
  output: {
    layer: 'output',
    code: 'OUTPUT_CONTRACT_VIOLATION',
    exitCode: CONTRACT_EXIT_CODES.HANDLER_ERROR,
    retry: 'none',
    description:
      "The handler's result did not validate against its declared output " +
      'contract (a server-side contract violation, never surfaced raw).',
  },
  presenter: {
    layer: 'presenter',
    code: 'PRESENTER_ERROR',
    exitCode: CONTRACT_EXIT_CODES.UNCAUGHT_EXCEPTION,
    retry: 'none',
    description:
      'The presentation projection (CLI/MCP rendering, redaction, exit-code ' +
      'mapping) threw while shaping an otherwise-valid envelope.',
  },
};

/** Total lookup of a family descriptor by layer (never `undefined`). */
export function failureFamily(layer: FailureLayer): FailureFamilyDescriptor {
  return FAMILY_DEFAULTS[layer];
}

/**
 * Coarse client-vs-server attribution of a failure layer. Live use-site for the
 * mandated `never` exhaustiveness proof (file header §2): a new unmapped layer
 * makes the `default` arm's `layer` non-`never`, breaking the build.
 */
export function layerSeverity(layer: FailureLayer): 'client' | 'server' {
  switch (layer) {
    case 'protocol':
      return 'client';
    case 'authorization':
      return 'client';
    case 'task':
      return 'server';
    case 'handler':
      return 'server';
    case 'output':
      return 'server';
    case 'presenter':
      return 'server';
    default:
      return assertNever(layer, 'FailureLayer');
  }
}

// ─── Stable error-code registry ─────────────────────────────────────────────

/**
 * Per-code override of the family default. A concrete stable code always
 * belongs to exactly one family; its exit code / retry policy default to the
 * family's but MAY be specialised (e.g. the bounded-`wait` codes carry the
 * 17/18 exits while still belonging to the `task` family).
 */
export interface StableErrorSpec {
  readonly layer: FailureLayer;
  readonly exitCode: ContractExitCode;
  readonly retry: RetryPolicy;
  /** Short human description of when the code is emitted. */
  readonly description: string;
}

/**
 * The enumerated registry of stable contract error codes. Every code has a
 * family, a CLI exit code, and a retry policy. Downstream generators (P03-03/04/05)
 * build their error tables from this authority; the CLI's per-code exit map is
 * a projection of the `exitCode` column.
 *
 * The family-default codes are registered here too, so `layerCodes(layer)` and
 * the coverage test can prove every family is represented.
 */
export const STABLE_ERROR_REGISTRY = {
  // ── protocol ──────────────────────────────────────────────────────────────
  PROTOCOL_ERROR: {
    layer: 'protocol',
    exitCode: CONTRACT_EXIT_CODES.INVALID_INPUT,
    retry: 'none',
    description: 'Generic transport/JSON-RPC/method admission failure.',
  },
  UNSUPPORTED_PROTOCOL_VERSION: {
    layer: 'protocol',
    exitCode: CONTRACT_EXIT_CODES.INVALID_INPUT,
    retry: 'none',
    description: 'The negotiated protocol/API version is outside the supported range.',
  },
  INVALID_INPUT: {
    layer: 'protocol',
    exitCode: CONTRACT_EXIT_CODES.INVALID_INPUT,
    retry: 'none',
    description: 'Input failed schema/required-field validation before dispatch.',
  },
  VERSION_INCOMPATIBLE: {
    layer: 'protocol',
    exitCode: CONTRACT_EXIT_CODES.INVALID_INPUT,
    retry: 'none',
    description:
      'A negotiated result version cannot be produced or migrated for this caller.',
  },
  // ── authorization ─────────────────────────────────────────────────────────
  AUTHORIZATION_DENIED: {
    layer: 'authorization',
    exitCode: CONTRACT_EXIT_CODES.HANDLER_ERROR,
    retry: 'none',
    description: 'Generic authorization denial (insufficient capability/posture).',
  },
  CAPABILITY_DENIED: {
    layer: 'authorization',
    exitCode: CONTRACT_EXIT_CODES.HANDLER_ERROR,
    retry: 'none',
    description: 'The principal lacks a capability the action requires.',
  },
  TRUSTED_CALLER_REQUIRED: {
    layer: 'authorization',
    exitCode: CONTRACT_EXIT_CODES.HANDLER_ERROR,
    retry: 'none',
    description: 'A privileged action was invoked without a trusted caller identity.',
  },
  // ── task ──────────────────────────────────────────────────────────────────
  TASK_FAILED: {
    layer: 'task',
    exitCode: CONTRACT_EXIT_CODES.HANDLER_ERROR,
    retry: 'after-backoff',
    description: 'Generic durable-Task failure.',
  },
  TASK_NOT_FOUND: {
    layer: 'task',
    exitCode: CONTRACT_EXIT_CODES.HANDLER_ERROR,
    retry: 'none',
    description: 'The referenced Task id does not exist (or was tombstoned).',
  },
  IDEMPOTENCY_SUBJECT_CONFLICT: {
    layer: 'task',
    exitCode: CONTRACT_EXIT_CODES.HANDLER_ERROR,
    retry: 'none',
    description:
      'An idempotency key was reused by a different subject — the stored result ' +
      'is not disclosed and re-execution is refused.',
  },
  IDEMPOTENCY_PAYLOAD_CONFLICT: {
    layer: 'task',
    exitCode: CONTRACT_EXIT_CODES.HANDLER_ERROR,
    retry: 'none',
    description:
      'An idempotency key was reused with a different request payload — a ' +
      'silently-different second execution is refused.',
  },
  WAIT_TIMEOUT: {
    layer: 'task',
    exitCode: CONTRACT_EXIT_CODES.WAIT_TIMEOUT,
    retry: 'after-backoff',
    description: 'A bounded wait expired before its predicate held.',
  },
  WAIT_FAILED: {
    layer: 'task',
    exitCode: CONTRACT_EXIT_CODES.WAIT_FAILED,
    retry: 'none',
    description: 'A terminal that can never satisfy the wait predicate arrived first.',
  },
  // ── handler ───────────────────────────────────────────────────────────────
  HANDLER_ERROR: {
    layer: 'handler',
    exitCode: CONTRACT_EXIT_CODES.HANDLER_ERROR,
    retry: 'none',
    description: "Generic action-handler business failure.",
  },
  INTERNAL_ERROR: {
    layer: 'handler',
    exitCode: CONTRACT_EXIT_CODES.HANDLER_ERROR,
    retry: 'none',
    description: 'An unexpected internal error escaped the handler (no stack leaked).',
  },
  CONCURRENCY_CONFLICT: {
    layer: 'handler',
    exitCode: CONTRACT_EXIT_CODES.HANDLER_ERROR,
    retry: 'after-refetch',
    description: 'The stream tail advanced during decide — re-fetch and re-decide.',
  },
  STORAGE_BUSY: {
    layer: 'handler',
    exitCode: CONTRACT_EXIT_CODES.HANDLER_ERROR,
    retry: 'after-backoff',
    description: 'The storage substrate is under cross-process write contention.',
  },
  // ── output ────────────────────────────────────────────────────────────────
  OUTPUT_CONTRACT_VIOLATION: {
    layer: 'output',
    exitCode: CONTRACT_EXIT_CODES.HANDLER_ERROR,
    retry: 'none',
    description: "A handler result failed its declared output-schema contract.",
  },
  // ── presenter ─────────────────────────────────────────────────────────────
  PRESENTER_ERROR: {
    layer: 'presenter',
    exitCode: CONTRACT_EXIT_CODES.UNCAUGHT_EXCEPTION,
    retry: 'none',
    description: 'The presentation projection threw while rendering an envelope.',
  },
} as const satisfies Readonly<Record<string, StableErrorSpec>>;

export type StableErrorCode = keyof typeof STABLE_ERROR_REGISTRY;

/** All registered stable error codes, sorted (deterministic for digesting). */
export function stableErrorCodes(): StableErrorCode[] {
  return (Object.keys(STABLE_ERROR_REGISTRY) as StableErrorCode[]).sort();
}

/** The registered codes that belong to `layer`, sorted. */
export function layerCodes(layer: FailureLayer): StableErrorCode[] {
  return stableErrorCodes().filter((code) => STABLE_ERROR_REGISTRY[code].layer === layer);
}

// ─── Contract error carrier ─────────────────────────────────────────────────

/**
 * The TOTAL error carrier. Every mapped failure produces one of these; the
 * shape is a structural superset of the live `ToolResult.error` block, so
 * {@link toErrorEnvelope} yields the canonical failure envelope unchanged.
 */
export interface ContractError {
  readonly code: string;
  readonly message: string;
  readonly layer: FailureLayer;
  readonly exitCode: ContractExitCode;
  readonly retry: RetryPolicy;
  /** Optional structured discriminators (validTargets, streamId, …). */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface ContractErrorOptions {
  /**
   * An explicit stable code. When it is registered its exit/retry win over the
   * family defaults; when omitted the family default code is used.
   */
  readonly code?: StableErrorCode;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * Build a {@link ContractError} for a failure at `layer`. Totality holds by
 * construction: `layer` is a `FailureLayer`, so `failureFamily(layer)` always
 * resolves and there is no unmapped branch.
 */
export function contractError(
  layer: FailureLayer,
  message: string,
  opts: ContractErrorOptions = {},
): ContractError {
  const family = failureFamily(layer);
  const code = opts.code ?? family.code;
  const spec = code in STABLE_ERROR_REGISTRY
    ? STABLE_ERROR_REGISTRY[code as StableErrorCode]
    : undefined;
  return {
    code,
    message,
    layer,
    exitCode: spec?.exitCode ?? family.exitCode,
    retry: spec?.retry ?? family.retry,
    ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
  };
}

/**
 * Resolve a stable CLI exit code from an error code. A registered code uses its
 * table entry; an unmapped/absent code falls to `HANDLER_ERROR` (the same
 * conservative fallback `adapters/cli.ts` uses today), and `undefined` (no
 * error) is `SUCCESS`.
 */
export function exitCodeForError(code: string | undefined): ContractExitCode {
  if (code === undefined) return CONTRACT_EXIT_CODES.SUCCESS;
  if (code in STABLE_ERROR_REGISTRY) {
    return STABLE_ERROR_REGISTRY[code as StableErrorCode].exitCode;
  }
  return CONTRACT_EXIT_CODES.HANDLER_ERROR;
}

/** The canonical failure-envelope projection of a {@link ContractError}. */
export interface ContractErrorEnvelope {
  readonly success: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly [k: string]: unknown;
  };
}

/**
 * Project a {@link ContractError} onto the live failure-envelope shape
 * (`{ success:false, error:{ code, message, …detail } }`) so the contract
 * layer and the runtime `ToolResult` failure branch agree byte-for-byte.
 */
export function toErrorEnvelope(err: ContractError): ContractErrorEnvelope {
  return {
    success: false,
    error: {
      code: err.code,
      message: err.message,
      ...(err.detail ?? {}),
    },
  };
}
