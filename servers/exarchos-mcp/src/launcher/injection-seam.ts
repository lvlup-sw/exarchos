// ─── Authority-bounded ephemeral orientation-injection seam (DR-7) ───────────
//
// At spawn, an ORIENTATION payload can be injected into the child's ENV channel
// (the `env: Record<string,string>` of the spawn descriptor) with **no repo-file
// mutation**. Orientation is transient — it lives only on the spawned process's
// environment, never on disk.
//
// ## Authority is MARKED, not ENFORCED
//
// The launcher does NOT own the model's prompt-precedence rules, so it cannot
// *force* orientation to lose to a user's own instructions. What it CAN do is:
//
//   1. **tag** the payload as `orientation` / non-authoritative — a DISTINCT
//      type and env channel from any authoritative `directive` channel, and
//   2. **place** it where a well-behaved consumer treats it as non-authoritative
//      (its own dedicated env keys, carrying an explicit `non-authoritative`
//      authority marker; never the directive key).
//
// A test therefore asserts the tag + placement, NOT runtime precedence over the
// model (which this seam cannot own — see `Injection_TaggedNonAuthoritative...`).
//
// ## Scope boundary
//
// Content/format of the orientation text is owned by #1485 — out of scope here.
// This module ships only the *seam*: the typed, tagged payload and the pure,
// file-free env placement. The lifecycle integrator (a sibling task) slots the
// seam output into the placed spawn descriptor; nothing here wires it live.
// ────────────────────────────────────────────────────────────────────────────

import type { AsyncSpawnRequest } from '../utils/process.js';

/**
 * Injection channel discriminant. Authority is a *property of the channel*, not
 * something this seam enforces at runtime:
 *   - `orientation` → non-authoritative, ephemeral context the launcher injects.
 *   - `directive`   → authoritative instruction channel the launcher does NOT emit.
 */
export type InjectionChannel = 'orientation' | 'directive';

/**
 * An ephemeral orientation payload — NON-authoritative by construction. Both the
 * `channel: 'orientation'` discriminant and the literal `authoritative: false`
 * are baked into the type, so the tag cannot silently collapse into the
 * authoritative {@link DirectivePayload}. `content` is opaque here (format owned
 * by #1485).
 */
export interface OrientationPayload {
  readonly channel: 'orientation';
  readonly authoritative: false;
  readonly content: string;
}

/**
 * The DISTINCT authoritative directive channel — the type-level counterpart the
 * orientation tag must never collapse into. The launcher does NOT emit these;
 * the type exists so the orientation channel is *provably* distinct, and so the
 * injector's refusal to ever write {@link DIRECTIVE_ENV_KEY} is expressible.
 */
export interface DirectivePayload {
  readonly channel: 'directive';
  readonly authoritative: true;
  readonly content: string;
}

/** Either injection channel's payload — discriminated by `channel`. */
export type InjectionPayload = OrientationPayload | DirectivePayload;

/**
 * Env var the ephemeral orientation *content* rides on — orientation's own
 * dedicated channel, DISTINCT from {@link DIRECTIVE_ENV_KEY}.
 */
export const ORIENTATION_ENV_KEY = 'EXARCHOS_ORIENTATION' as const;

/**
 * Env var carrying the explicit authority marker for the orientation payload.
 * A well-behaved consumer reads {@link NON_AUTHORITATIVE} here and defers the
 * orientation to any user instruction rather than treating it as a directive.
 */
export const ORIENTATION_AUTHORITY_ENV_KEY = 'EXARCHOS_ORIENTATION_AUTHORITY' as const;

/**
 * Env var an authoritative directive channel would use — DISTINCT from the two
 * orientation keys. {@link injectOrientation} NEVER writes it: orientation
 * cannot masquerade as a directive.
 */
export const DIRECTIVE_ENV_KEY = 'EXARCHOS_DIRECTIVE' as const;

/** The placed authority marker value for a non-authoritative orientation payload. */
export const NON_AUTHORITATIVE = 'non-authoritative' as const;

/**
 * Build a non-authoritative orientation payload from opaque content. The tag
 * (`channel` + `authoritative`) is fixed by construction; content/format is #1485's.
 */
export function orientationPayload(content: string): OrientationPayload {
  return { channel: 'orientation', authoritative: false, content };
}

// ─── Compile-time tag invariants (gated by `tsc --noEmit`) ───────────────────
//
// `tsconfig.json` EXCLUDES `**/*.test.ts` from compilation, so a type-level
// assertion in the test file would NOT be gated by `tsc`. These invariants
// therefore live in this (compiled) source module. Each alias resolves to `true`
// when the tag holds and to `never` otherwise; assigning `true` to a `never`
// slot is the `tsc` error that fires if a tag ever collapses. The tuple is
// EXPORTED (so it is not dead code) and re-asserted at runtime in the test.

/** `true` iff the orientation channel discriminant is still `'orientation'`. */
type AssertOrientationChannel = OrientationPayload['channel'] extends 'orientation' ? true : never;

/** `true` iff orientation is still typed non-authoritative (`authoritative: false`). */
type AssertOrientationNonAuthoritative =
  OrientationPayload['authoritative'] extends false ? true : never;

/**
 * `true` iff the orientation and directive channels are DISTINCT — i.e. the
 * orientation discriminant does not extend the directive discriminant. Collapse
 * them (e.g. give orientation `channel: 'directive'`) and this becomes `never`.
 */
type AssertChannelsDistinct =
  OrientationPayload['channel'] extends DirectivePayload['channel'] ? never : true;

/**
 * The three tag invariants, proven at compile time. A green `tsc --noEmit` is
 * the real guarantee; the exported value is the runtime anchor the test pins.
 */
export const ORIENTATION_TAG_INVARIANTS: readonly [
  AssertOrientationChannel,
  AssertOrientationNonAuthoritative,
  AssertChannelsDistinct,
] = [true, true, true];

/**
 * Ephemerally inject an orientation payload into a spawn request's ENV channel —
 * with **NO repo-file mutation** (this function touches no filesystem at all).
 *
 * Returns a NEW request whose `env` additionally carries the orientation content
 * ({@link ORIENTATION_ENV_KEY}) and its non-authoritative authority marker
 * ({@link ORIENTATION_AUTHORITY_ENV_KEY}); the base request is never mutated and
 * {@link DIRECTIVE_ENV_KEY} is never written.
 *
 * Absent a payload (`undefined`), the base request is returned UNCHANGED — same
 * reference, so launch is byte-for-byte identical and adds zero env keys.
 *
 * Designed to slot into the placed spawn descriptor in the lifecycle integrator:
 * `injectOrientation({ ...descriptor, cwd: worktreePath }, orientation)`.
 */
export function injectOrientation(
  base: AsyncSpawnRequest,
  payload: OrientationPayload | undefined,
): AsyncSpawnRequest {
  if (payload === undefined) return base;
  return {
    ...base,
    env: {
      ...base.env,
      [ORIENTATION_ENV_KEY]: payload.content,
      [ORIENTATION_AUTHORITY_ENV_KEY]: NON_AUTHORITATIVE,
    },
  };
}
