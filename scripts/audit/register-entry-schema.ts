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

/**
 * The minimal shared shape every register entry satisfies (before key fields).
 *
 * The two optional fields are `| undefined` deliberately, not decoratively.
 * `z.infer` of an `.optional()` field is `T | undefined` under
 * `exactOptionalPropertyTypes`, so without the widening every caller passing a
 * validated entry into {@link isEntryExpired} — which is every caller — fails to
 * compile. That was invisible until task 066 brought `scripts/` under `tsc`.
 */
export type RegisterEntryBase = {
  owner: string;
  rationale: string;
  expires?: string | undefined;
  permanent?: true | undefined;
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
    .refine(
      (entry) => {
        const { expires, permanent } = exemptionFields(entry);
        return (expires !== undefined) !== (permanent === true);
      },
      {
        message:
          'each entry must set EXACTLY ONE of `expires` (a YYYY-MM-DD review deadline) or `permanent: true`',
      },
    );
}

/**
 * Read the XOR pair off a parsed entry.
 *
 * The refinement runs on the OUTPUT of a schema built from a generic shape `T`,
 * whose type Zod cannot reduce to a property bag while `T` is unresolved — so
 * `entry.expires` does not typecheck at the definition site even though it
 * always exists at runtime. Reading the two fields reflectively keeps the
 * refinement's behaviour identical and costs no type assertion; the surrounding
 * `.object()` is what guarantees their shapes. (Surfaced by task 066, the first
 * typecheck this tree has ever had.)
 */
function exemptionFields(entry: unknown): {
  readonly expires: unknown;
  readonly permanent: unknown;
} {
  if (typeof entry !== 'object' || entry === null) {
    return { expires: undefined, permanent: undefined };
  }
  return { expires: Reflect.get(entry, 'expires'), permanent: Reflect.get(entry, 'permanent') };
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

/**
 * The EDGE-KEYED register (task 010, DR-4/DR-8) — the `cycle-baseline.json`
 * entry schema. It keys each accepted runtime import cycle on its back-edge
 * (`{ from, to }`) plus the flagging `rule` and tracking `issue`, and inherits
 * the shared `{ owner, rationale, expires XOR permanent }` accountability
 * contract through {@link makeRegisterSchema} — the SAME seam the knip
 * dead-export register uses, NOT a forked validator. `.strict()` rejects typo
 * fields; the edge gate (`scripts/audit/cycle-gate.ts`) validates every baseline
 * entry against this schema and fails closed when it does not conform.
 */
export const edgeRegisterSchema = makeRegisterSchema({
  /** Repo-relative source module of the accepted cycle back-edge. */
  from: z.string().min(1, '`from` is required (repo-relative back-edge source module)'),
  /** Repo-relative target module of the accepted cycle back-edge. */
  to: z.string().min(1, '`to` is required (repo-relative back-edge target module)'),
  /** The depcruise rule that flags the edge (e.g. `no-circular`). */
  rule: z.string().min(1, '`rule` is required (the depcruise rule, e.g. no-circular)'),
  /** Tracking issue for retiring the edge. */
  issue: z.string().min(1, '`issue` is required (tracking issue for the fix)'),
});
/** A validated `cycle-baseline.json` entry (task 010). */
export type EdgeRegisterEntry = z.infer<typeof edgeRegisterSchema>;
