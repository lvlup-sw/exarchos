/**
 * register-entry-schema.ts — the ONE shared validator for "register" entries.
 *
 * A *register* is any hand-maintained allowlist that grants a symbol/edge/etc. a
 * documented, time-boxed exemption from an automated gate. Several gates ship
 * their own register (this task's knip dead-export allowlist is the first; task
 * 010's edge-keyed capability register is the next). Every register — whatever
 * it keys on — MUST agree on the same accountability contract so the debt is
 * always owned, justified, and either time-boxed or explicitly permanent:
 *
 *   { owner, rationale, (expires XOR permanent) }        ← shared, enforced here
 *   { …register-specific key fields… }                   ← per-register, injected
 *
 * The *key fields* (what uniquely identifies an entry) stay per-register: this
 * task keys on `{ symbol, file }`; a future edge register keys on `{ from, to }`.
 * `makeRegisterSchema(keyFields)` is the single extension seam — a new register
 * passes ITS key shape and inherits the shared contract unchanged. Do not fork
 * this contract per register; extend it here.
 */
import { z } from 'zod';

/**
 * Strict `YYYY-MM-DD` calendar date. Rejects malformed strings AND impossible
 * rollovers (`2026-02-30`) by round-tripping through `Date` and comparing back.
 */
function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

const isoDate = z
  .string()
  .refine(isValidIsoDate, { message: '`expires` must be a real calendar date in YYYY-MM-DD form' });

/**
 * The shared accountability fields carried by EVERY register entry. Kept
 * private: registers compose it through {@link makeRegisterSchema}, never by
 * spreading the raw shape, so the XOR refinement below is always applied.
 */
const registerEntryBaseShape = {
  /** Who owns retiring this exemption (a `@handle` or team). Required, non-empty. */
  owner: z.string().min(1, '`owner` is required (assign a @handle or team)'),
  /** Why the exemption exists — the review a future reader needs. Required, non-empty. */
  rationale: z.string().min(1, '`rationale` is required (explain why this is exempt)'),
  /** Review deadline, `YYYY-MM-DD`. Mutually exclusive with `permanent`. */
  expires: isoDate.optional(),
  /** Marks a structurally-permanent exemption (e.g. codegen-emitted symbol). */
  permanent: z.literal(true).optional(),
};

/** The minimal shared shape every register entry satisfies (before key fields). */
export type RegisterEntryBase = {
  owner: string;
  rationale: string;
  expires?: string;
  permanent?: true;
};

/**
 * Build a strict schema for a specific register by supplying its key fields.
 * The result validates the shared `{ owner, rationale, expires XOR permanent }`
 * contract PLUS the register's own keys, and rejects unknown fields so a typo
 * (`owener`, `expiry`) fails loudly instead of silently voiding the contract.
 *
 * @example
 *   // this task — dead-export allowlist keyed on symbol + file
 *   const schema = makeRegisterSchema({
 *     symbol: z.string().min(1),
 *     file: z.string().min(1),
 *   });
 *   // task 010 — capability-edge register keyed on from + to
 *   const edgeSchema = makeRegisterSchema({ from: z.string(), to: z.string() });
 */
export function makeRegisterSchema<T extends z.ZodRawShape>(keyFields: T) {
  return z
    .object({ ...registerEntryBaseShape, ...keyFields })
    .strict()
    .refine((entry) => (entry.expires !== undefined) !== (entry.permanent === true), {
      message:
        'each entry must set EXACTLY ONE of `expires` (a YYYY-MM-DD review deadline) or `permanent: true`',
    });
}

/**
 * Has a register entry passed its review deadline as of `now`? A `permanent`
 * entry never expires; an `expires` entry stays valid THROUGH the end (UTC) of
 * its deadline day, so a gate keeps passing on the deadline date itself and
 * flips the day after.
 */
export function isEntryExpired(entry: RegisterEntryBase, now: Date): boolean {
  if (entry.permanent) return false;
  if (!entry.expires) return false;
  const endOfDeadline = new Date(`${entry.expires}T23:59:59.999Z`);
  return now.getTime() > endOfDeadline.getTime();
}
