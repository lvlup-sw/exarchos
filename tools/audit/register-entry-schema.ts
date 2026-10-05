/**
 * The shared validator for register entries. A register is a hand-kept allowlist
 * that exempts an item from an automated gate. Examples are the knip dead-export
 * allowlist in `knip-diff.ts` and the cycle baseline in `cycle-gate.ts`.
 *
 * Each entry has an owner, a rationale, and exactly one of `expires` or `permanent`.
 * The key fields differ per register. A new register passes its key fields to
 * `makeRegisterSchema` and does not fork the shared contract.
 */
import { z } from 'zod';

/** True for a real `YYYY-MM-DD` date. A round trip through `Date` rejects rollovers such as `2026-02-30`. */
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
 * The shared fields of each register entry. It stays private, so each register gets
 * the `expires` or `permanent` refinement through {@link makeRegisterSchema}.
 */
const registerEntryBaseShape = {
  /** Who owns retiring this exemption (a `@handle` or team). Required, non-empty. */
  owner: z.string().min(1, '`owner` is required (assign a @handle or team)'),
  /** Why the exemption exists. Required, non-empty. */
  rationale: z.string().min(1, '`rationale` is required (explain why this is exempt)'),
  /** Review deadline, `YYYY-MM-DD`. Mutually exclusive with `permanent`. */
  expires: isoDate.optional(),
  /** Marks a permanent exemption, for example a symbol that codegen emits. */
  permanent: z.literal(true).optional(),
};

/**
 * The shared shape of a register entry, without key fields. The optional fields
 * include `| undefined`, because `z.infer` gives `T | undefined` under
 * `exactOptionalPropertyTypes`. Without it, a validated entry is not a valid
 * argument to {@link isEntryExpired}.
 */
export type RegisterEntryBase = {
  owner: string;
  rationale: string;
  expires?: string | undefined;
  permanent?: true | undefined;
};

/**
 * Builds a strict schema for one register from its key fields. It checks the shared
 * fields and the keys, and rejects unknown fields, so a typo such as `expiry` fails.
 *
 * @example
 *   const schema = makeRegisterSchema({ symbol: z.string().min(1), file: z.string().min(1) });
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
 * Reads `expires` and `permanent` off a parsed entry. Zod cannot reduce the output
 * type of a generic shape `T` to a property bag, so `entry.expires` does not
 * typecheck here. A reflective read needs no type assertion, and `.object()` checks the shapes.
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
 * True when the entry is past its review deadline at `now`. A `permanent` entry never
 * expires. An `expires` entry stays valid through the end of its deadline day in UTC.
 */
export function isEntryExpired(entry: RegisterEntryBase, now: Date): boolean {
  if (entry.permanent) return false;
  if (!entry.expires) return false;
  const endOfDeadline = new Date(`${entry.expires}T23:59:59.999Z`);
  return now.getTime() > endOfDeadline.getTime();
}

/**
 * The entry schema of `cycle-baseline.json`. It keys each accepted import cycle on its
 * back-edge (`from`, `to`), the flagging `rule`, and the tracking `issue`.
 * `tools/audit/cycle-gate.ts` checks each baseline entry against it and throws on a mismatch.
 */
export const edgeRegisterSchema = makeRegisterSchema({
  /** Repo-relative source module of the accepted cycle back-edge. */
  from: z.string().min(1, '`from` is required (repo-relative back-edge source module)'),
  /** Repo-relative target module of the accepted cycle back-edge. */
  to: z.string().min(1, '`to` is required (repo-relative back-edge target module)'),
  /** The depcruise rule that flags the edge, for example `no-circular`. */
  rule: z.string().min(1, '`rule` is required (the depcruise rule, e.g. no-circular)'),
  /** Tracking issue for retiring the edge. */
  issue: z.string().min(1, '`issue` is required (tracking issue for the fix)'),
});
/** A validated `cycle-baseline.json` entry. */
export type EdgeRegisterEntry = z.infer<typeof edgeRegisterSchema>;
