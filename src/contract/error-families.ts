// The closed mapping from each failure origin to one stable contract error code and one CLI exit code.
// Every failure in every layer maps, and no failure falls through to an unmapped generic case.
// - `protocol`: transport, JSON-RPC, method, version, or schema admission.
// - `authorization`: principal, capability, reserved event, or idempotency scope.
// - `task`: durable Task identity, ownership, lease, or cancellation.
// - `handler`: the decision of the action handler, which is a business failure.
// - `output`: the result violates its declared output contract.
// - `presenter`: the CLI or MCP render failed.
// Totality has two compile-time proofs and one runtime proof.
// `FAMILY_DEFAULTS` is a `Record<FailureLayer, …>`, so a new layer without a descriptor does not compile.
// `layerSeverity` ends in `assertNever`, so a new unhandled layer does not compile.
// At runtime, `assertNever` throws when an unsound cast reaches it.
// The module has no I/O and no clock, so the contract authority can digest it.

/**
 * Compile-time exhaustiveness guard. After a chain narrows a union to nothing, the residual value is `never`.
 * A new union member without an arm does not compile here. At runtime the call throws.
 */
export function assertNever(value: never, context = 'value'): never {
  throw new Error(`Non-exhaustive ${context}: ${JSON.stringify(value)}`);
}

/** The failure origins, in pipeline order. Each member maps to a stable code and a CLI exit. */
export const FAILURE_LAYERS = [
  'protocol',
  'authorization',
  'task',
  'handler',
  'output',
  'presenter',
] as const;

export type FailureLayer = (typeof FAILURE_LAYERS)[number];

/**
 * The contract authority for CLI exit codes. Codes 0 to 3 are success, input, handler, and uncaught.
 * Codes 17 and 18 are the two bounded-`wait` outcomes, above the low band so they never alias it.
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

/**
 * How a caller reacts to a failure code.
 * - `none`: the request cannot succeed as it is. Do not retry.
 * - `after-backoff`: retry the same request after a delay, as for `STORAGE_BUSY`.
 * - `after-refetch`: the prior read is stale. Read the state again and decide again, as for `CONCURRENCY_CONFLICT`.
 */
export type RetryPolicy = 'none' | 'after-backoff' | 'after-refetch';

export interface FailureFamilyDescriptor {
  readonly layer: FailureLayer;
  /** The default stable contract error code of the family. */
  readonly code: string;
  /** The default stable CLI exit code of the family. */
  readonly exitCode: ContractExitCode;
  readonly retry: RetryPolicy;
  readonly description: string;
}

/** The total family map. `Record<FailureLayer, …>` requires every layer. */
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

/** Look up the family descriptor of a layer. The result is never `undefined`. */
export function failureFamily(layer: FailureLayer): FailureFamilyDescriptor {
  return FAMILY_DEFAULTS[layer];
}

/** Attribute a failure layer to the client or the server. The `assertNever` default breaks the build for a new layer. */
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

/**
 * The spec of one stable code, which belongs to exactly one family.
 * Its exit code and retry policy can differ from the family defaults. The bounded-`wait` codes exit with 17 and 18 in the `task` family.
 */
export interface StableErrorSpec {
  readonly layer: FailureLayer;
  readonly exitCode: ContractExitCode;
  readonly retry: RetryPolicy;
  /** A short description of when the code occurs. */
  readonly description: string;
}

/**
 * The registry of stable contract error codes. Each code has a family, a CLI exit code, and a retry policy.
 * The family-default codes are here too, so `layerCodes(layer)` shows each family.
 */
export const STABLE_ERROR_REGISTRY = {
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
  OUTPUT_CONTRACT_VIOLATION: {
    layer: 'output',
    exitCode: CONTRACT_EXIT_CODES.HANDLER_ERROR,
    retry: 'none',
    description: "A handler result failed its declared output-schema contract.",
  },
  PRESENTER_ERROR: {
    layer: 'presenter',
    exitCode: CONTRACT_EXIT_CODES.UNCAUGHT_EXCEPTION,
    retry: 'none',
    description: 'The presentation projection threw while rendering an envelope.',
  },
} as const satisfies Readonly<Record<string, StableErrorSpec>>;

export type StableErrorCode = keyof typeof STABLE_ERROR_REGISTRY;

/** All registered stable error codes, sorted for a deterministic digest. */
export function stableErrorCodes(): StableErrorCode[] {
  return (Object.keys(STABLE_ERROR_REGISTRY) as StableErrorCode[]).sort();
}

/** The registered codes that belong to `layer`, sorted. */
export function layerCodes(layer: FailureLayer): StableErrorCode[] {
  return stableErrorCodes().filter((code) => STABLE_ERROR_REGISTRY[code].layer === layer);
}

/** The error carrier of every mapped failure. Its shape is a superset of `ToolResult.error`. */
export interface ContractError {
  readonly code: string;
  readonly message: string;
  readonly layer: FailureLayer;
  readonly exitCode: ContractExitCode;
  readonly retry: RetryPolicy;
  /** Optional structured discriminators, such as `validTargets` or `streamId`. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface ContractErrorOptions {
  /** An explicit stable code. A registered code overrides the family exit and retry defaults. Without it, the family code applies. */
  readonly code?: StableErrorCode;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** Build a {@link ContractError} for a failure at `layer`. `failureFamily(layer)` always resolves. */
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
 * Resolve a CLI exit code from an error code. An unregistered code gives `HANDLER_ERROR`.
 * `undefined` means no error, so it gives `SUCCESS`.
 * This maps a code, not a result. For a dispatched result, use {@link exitCodeForResult}.
 */
export function exitCodeForError(code: string | undefined): ContractExitCode {
  if (code === undefined) return CONTRACT_EXIT_CODES.SUCCESS;
  if (code in STABLE_ERROR_REGISTRY) {
    return STABLE_ERROR_REGISTRY[code as StableErrorCode].exitCode;
  }
  return CONTRACT_EXIT_CODES.HANDLER_ERROR;
}

/** The code of a failure envelope whose result carries no code. `format.toEnvelope` uses it, so both surfaces agree. */
export const UNSPECIFIED_FAILURE_CODE = 'INTERNAL_ERROR';

/** The minimal result shape the exit-code authority reads. */
export interface ExitCodeSubject {
  readonly success: boolean;
  readonly error?: { readonly code?: string } | undefined;
}

/**
 * The authority that maps a dispatched result to its process exit code. `adapters/cli.resolveExitCode` delegates to it.
 * `success: true` gives 0. Otherwise {@link exitCodeForError} resolves the code, with {@link UNSPECIFIED_FAILURE_CODE} for a missing code.
 * A failure never resolves to 0, even when a registry entry carries `exitCode: 0`.
 * The MCP wire renders `success: false` with no `error` as `isError: true`, so the CLI must fail too.
 */
export function exitCodeForResult(result: ExitCodeSubject): ContractExitCode {
  if (result.success) return CONTRACT_EXIT_CODES.SUCCESS;
  const resolved = exitCodeForError(result.error?.code ?? UNSPECIFIED_FAILURE_CODE);
  return resolved === CONTRACT_EXIT_CODES.SUCCESS ? CONTRACT_EXIT_CODES.HANDLER_ERROR : resolved;
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

/** Project a {@link ContractError} onto the `ToolResult` failure-envelope shape. */
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
