// ─── Authenticated request context + replay identity (P03-02) ────────────────
//
// PROGRAM-03, API-002/API-006 (consumes P01-07). Two closely-related contracts:
//
//  1. AuthenticatedRequestContext — a typed, per-request context that carries
//     the principal + capabilities DERIVED from transport/dispatch. It is built
//     ONLY from a {@link CallerAuthorizationSnapshot} (which `caller-identity.ts`
//     mints from adapter-owned runtime inputs — session id, state dir — never
//     from the caller's payload). Any caller-supplied `_meta` hints are treated
//     as UNTRUSTED and sanitised: a caller cannot self-assert issuer, role,
//     subject, posture, capabilities, policy, or timestamp. This module does
//     NOT re-derive identity — it consumes P01-07's frozen snapshot.
//
//  2. Replay identity / idempotency — a replayed request returns the canonical
//     STORED result or a typed conflict; it never silently runs a different
//     second execution. The replay identity binds the idempotency key to the
//     authenticated SUBJECT and the canonical request digest, so key reuse by a
//     different subject or with a different payload is a conflict rather than a
//     stored-result disclosure / duplicate effect.
//
// Pure (the only impurity is `createHash`, deterministic). Digested as part of
// the frozen `contract-surface` authority (`contract-surface.ts`).
// ────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import type { CallerAuthorizationSnapshot } from '../dispatch/caller-identity.js';
import { contractError, type ContractError } from './error-families.js';

// ─── Untrusted-hint sanitisation ────────────────────────────────────────────

/**
 * `_meta` keys a caller must NOT be able to assert. They are derived
 * exclusively from the authenticated {@link CallerAuthorizationSnapshot}; a
 * caller-supplied value for any of them is stripped before the hints reach a
 * handler. (P01-07: callers cannot self-assert issuer, role, or timestamp.)
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

// ─── Authenticated request context ──────────────────────────────────────────

/**
 * The per-request context handed to a handler. `authorization` is the frozen
 * P01-07 snapshot (the sole source of principal + capabilities); `hints` are
 * the sanitised, non-authoritative caller `_meta`.
 */
export interface AuthenticatedRequestContext {
  readonly authorization: CallerAuthorizationSnapshot;
  readonly hints: Readonly<Record<string, unknown>>;
}

/**
 * Build an {@link AuthenticatedRequestContext} from a frozen authorization
 * snapshot and (optionally) the caller's untrusted `_meta`. The snapshot is the
 * ONLY identity source; the hints are sanitised so no protected field survives.
 * Callers therefore cannot override subject/role/issuer/timestamp/capabilities.
 */
export function deriveRequestContext(
  authorization: CallerAuthorizationSnapshot,
  untrustedMeta?: Readonly<Record<string, unknown>>,
): AuthenticatedRequestContext {
  return Object.freeze({
    authorization,
    hints: sanitizeUntrustedHints(untrustedMeta),
  });
}

/** The authenticated subject id — the only identity a replay claim may bind to. */
export function contextSubjectId(ctx: AuthenticatedRequestContext): string {
  return ctx.authorization.identity.subjectId;
}

// ─── Canonical request digest ───────────────────────────────────────────────

/**
 * Deterministic JSON with recursively sorted object keys, so two structurally
 * equal request payloads (regardless of key order) digest identically. Arrays
 * preserve order (semantically significant); `undefined` object properties are
 * dropped (JSON has no `undefined`).
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

// ─── Replay identity / idempotency ──────────────────────────────────────────

/**
 * The identity a request is replayed under. The idempotency key is bound to the
 * authenticated `subjectId` and the canonical `requestDigest` so key reuse by a
 * different subject or with a different payload is detectable.
 */
export interface ReplayIdentity {
  readonly idempotencyKey: string;
  readonly subjectId: string;
  readonly requestDigest: string;
}

/**
 * Derive a {@link ReplayIdentity} from the authenticated context, the caller's
 * idempotency key, and the request payload. The subject is taken from the
 * context (never the caller's `_meta`), closing the "reuse a key under a
 * different subject" hole.
 */
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
 * An in-memory replay/idempotency ledger. This is the CONTRACT model of the
 * durable claim ledger (API-002): it fixes the semantics a persistent
 * implementation must honour, and is directly unit-testable.
 *
 * Semantics of {@link ReplayLedger.claim}:
 *
 *   - first claim for a key     → executes once, stores, `status:'executed'`.
 *   - same key, same subject,
 *     same request digest        → `status:'replayed'` with the STORED result;
 *                                   the executor is NOT run again (no silently
 *                                   different second execution).
 *   - same key, DIFFERENT subject → `status:'conflict'`
 *                                   (`IDEMPOTENCY_SUBJECT_CONFLICT`); the stored
 *                                   result is NOT disclosed and nothing runs.
 *   - same key, same subject,
 *     DIFFERENT request digest    → `status:'conflict'`
 *                                   (`IDEMPOTENCY_PAYLOAD_CONFLICT`); nothing runs.
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

  /** Whether a key has an outstanding claim (test/introspection helper). */
  has(idempotencyKey: string): boolean {
    return this.store.has(idempotencyKey);
  }
}
