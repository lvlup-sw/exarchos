// The authenticated request context and the replay identity.
// The context carries the principal and capabilities from a `CallerAuthorizationSnapshot` only.
// The module strips protected fields from the caller `_meta` hints, so a caller cannot assert identity or authority.
// A replay returns the stored result or a typed conflict, and never runs a different second execution.
// The replay identity binds the idempotency key to the subject and the request digest.
//
// The only impurity is the deterministic `createHash`.
// The `contract-surface` authority digests `PROTECTED_CONTEXT_FIELDS`, so a change to that list trips the authority freeze.

import { createHash } from 'node:crypto';
import type { CallerAuthorizationSnapshot } from '../dispatch/caller-identity.js';
import { contractError, type ContractError } from './error-families.js';

/**
 * The `_meta` keys that a caller cannot assert. Their values come from the {@link CallerAuthorizationSnapshot}.
 * The sanitizer strips a caller-supplied value for any of them.
 */
export const PROTECTED_CONTEXT_FIELDS = [
  'subjectId',
  'subject',
  'issuer',
  'role',
  'kind',
  'principal',
  'posture',
  'capabilities',
  'capability',
  'policy',
  'resolver',
  'resolvedAt',
  'timestamp',
] as const;

export type ProtectedContextField = (typeof PROTECTED_CONTEXT_FIELDS)[number];

const PROTECTED_SET: ReadonlySet<string> = new Set(PROTECTED_CONTEXT_FIELDS);

/** True when `key` is an identity/authorization field a caller cannot assert. */
export function isProtectedContextField(key: string): boolean {
  return PROTECTED_SET.has(key);
}

/**
 * Strip every {@link PROTECTED_CONTEXT_FIELDS} key from an untrusted `_meta`
 * bag, returning only the harmless hints. A frozen copy is returned so a
 * handler cannot mutate the caller's object.
 */
export function sanitizeUntrustedHints(
  meta: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (meta !== undefined) {
    for (const [key, value] of Object.entries(meta)) {
      if (!isProtectedContextField(key)) out[key] = value;
    }
  }
  return Object.freeze(out);
}

/** The per-request context for a handler. `authorization` is the only source of identity, and `hints` are the sanitized caller `_meta`. */
export interface AuthenticatedRequestContext {
  readonly authorization: CallerAuthorizationSnapshot;
  readonly hints: Readonly<Record<string, unknown>>;
}

/** Build an {@link AuthenticatedRequestContext}. No protected field of the untrusted `_meta` survives. */
export function deriveRequestContext(
  authorization: CallerAuthorizationSnapshot,
  untrustedMeta?: Readonly<Record<string, unknown>>,
): AuthenticatedRequestContext {
  return Object.freeze({
    authorization,
    hints: sanitizeUntrustedHints(untrustedMeta),
  });
}

/** The authenticated subject id, which is the only identity that a replay claim binds to. */
export function contextSubjectId(ctx: AuthenticatedRequestContext): string {
  return ctx.authorization.identity.subjectId;
}

/**
 * Deterministic JSON with recursively sorted object keys, so key order does not change the digest.
 * Arrays keep their order. The function drops object properties that are `undefined`.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = canonicalize(v);
    return out;
  }
  return value;
}

/** `sha256:<hex>` digest of a request payload's canonical JSON. */
export function requestDigest(payload: unknown): string {
  const hex = createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
  return `sha256:${hex}`;
}

/** The replay identity of a request. It binds the idempotency key to the subject and the request digest. */
export interface ReplayIdentity {
  readonly idempotencyKey: string;
  readonly subjectId: string;
  readonly requestDigest: string;
}

/** Derive a {@link ReplayIdentity}. The subject comes from the context, never from the caller `_meta`. */
export function deriveReplayIdentity(
  ctx: AuthenticatedRequestContext,
  idempotencyKey: string,
  payload: unknown,
): ReplayIdentity {
  if (idempotencyKey.length === 0) {
    throw new Error('deriveReplayIdentity: idempotencyKey must be non-empty');
  }
  return {
    idempotencyKey,
    subjectId: contextSubjectId(ctx),
    requestDigest: requestDigest(payload),
  };
}

/** The outcome of a replay claim. */
export type ReplayOutcome<R> =
  | { readonly status: 'executed'; readonly result: R }
  | { readonly status: 'replayed'; readonly result: R }
  | { readonly status: 'conflict'; readonly error: ContractError };

interface ReplayRecord<R> {
  readonly subjectId: string;
  readonly requestDigest: string;
  readonly result: R;
}

/**
 * An in-memory model of the durable claim ledger. It fixes the semantics that a persistent ledger must keep.
 * - The first claim for a key runs the executor once and returns `executed`.
 * - The same key, subject, and digest return `replayed` with the stored result, and nothing runs.
 * - A different subject returns `IDEMPOTENCY_SUBJECT_CONFLICT`. The stored result stays hidden.
 * - The same subject with a different digest returns `IDEMPOTENCY_PAYLOAD_CONFLICT`.
 * Neither conflict runs the executor.
 */
export class ReplayLedger<R> {
  private readonly store = new Map<string, ReplayRecord<R>>();

  claim(identity: ReplayIdentity, execute: () => R): ReplayOutcome<R> {
    const existing = this.store.get(identity.idempotencyKey);

    if (existing === undefined) {
      const result = execute();
      this.store.set(identity.idempotencyKey, {
        subjectId: identity.subjectId,
        requestDigest: identity.requestDigest,
        result,
      });
      return { status: 'executed', result };
    }

    if (existing.subjectId !== identity.subjectId) {
      return {
        status: 'conflict',
        error: contractError(
          'task',
          `idempotency key '${identity.idempotencyKey}' was first claimed by a ` +
            'different subject; the stored result is withheld and re-execution refused',
          { code: 'IDEMPOTENCY_SUBJECT_CONFLICT' },
        ),
      };
    }

    if (existing.requestDigest !== identity.requestDigest) {
      return {
        status: 'conflict',
        error: contractError(
          'task',
          `idempotency key '${identity.idempotencyKey}' was reused with a different ` +
            'request payload; a silently-different second execution is refused',
          { code: 'IDEMPOTENCY_PAYLOAD_CONFLICT' },
        ),
      };
    }

    return { status: 'replayed', result: existing.result };
  }

  /** Return true when a key has a claim. */
  has(idempotencyKey: string): boolean {
    return this.store.has(idempotencyKey);
  }
}

/**
 * A replay policy bound to the {@link ReplayIdentity} keys.
 * It has the shape of the action-contract replay policy, but stays local so this module does not import the registry.
 */
export type BoundReplayPolicy =
  | { readonly kind: 'safe-repeat' }
  | { readonly kind: 'claim-required'; readonly scope: 'stream-subject-request' }
  | { readonly kind: 'reject-replay'; readonly because: string };

/**
 * Apply a replay policy to the claim ledger within one process.
 * No policy and `safe-repeat` run without a claim. `claim-required` calls {@link ReplayLedger.claim}.
 * `reject-replay` runs the first claim and refuses a second claim without running the executor.
 * The bounded action executor enforces the `reject-replay` of a compiled leaf separately, from the event store.
 */
export function applyReplayPolicy<R>(
  replay: BoundReplayPolicy | undefined,
  identity: ReplayIdentity,
  ledger: ReplayLedger<R>,
  execute: () => R,
): ReplayOutcome<R> {
  if (replay === undefined || replay.kind === 'safe-repeat') {
    return { status: 'executed', result: execute() };
  }
  if (replay.kind === 'reject-replay') {
    if (ledger.has(identity.idempotencyKey)) {
      return {
        status: 'conflict',
        error: contractError('task', replay.because),
      };
    }
    return ledger.claim(identity, execute);
  }
  return ledger.claim(identity, execute);
}
