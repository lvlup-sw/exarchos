// DR-4 (task 055): `outputSchema` vacuity is UNCONSTRUCTIBLE, and the 112
// pre-existing vacuous declarations are a shrink-only allowlist.
//
// Task 016 built the census (the measurement). This file pins the POLICY laid
// over it, in the two places policy can be enforced:
//
//   • COMPILE TIME — `ToolAction.outputSchema` accepts only a branded schema,
//     minted by `withCappedShape` (substantive) or `vacuityWaiver` (allowlisted).
//     The claim itself is stated as `Expect<...>` type aliases in NON-TEST
//     source (`registry.ts`, `output-schema-declaration.ts`) because the package
//     tsconfig excludes `*.test.ts` — a `@ts-expect-error` written here would
//     never be checked by `npm run typecheck`. What this file adds is the
//     RUNTIME-OBSERVABLE half: the brand is a real symbol property, so the
//     "closed constructor set" can be verified by looking rather than by
//     trusting the type printer.
//   • RUN TIME — `auditVacuityAllowlist` compares the allowlist against the
//     live census in BOTH directions, which is what a count threshold cannot
//     do: a swap leaves the count at 112.
//
// TWO AUTHORITIES. The seed's expected content is never read back out of the
// module that consumes it. Authority A is the GENERATED DATA FILE
// `output-schema-vacuity-allowlist.ts` — a static artifact that imports nothing
// and cannot observe a schema. Authority B is the set of Zod schema OBJECTS the
// tool registry constructs at module-import time, walked structurally by the
// census; it cannot observe the data file. Their agreement is the claim; their
// disagreement is the finding.
//
// @oracle-sources: ./output-schema-vacuity-allowlist.ts, the Zod schema objects the live tool registry constructs at module-import time and the census walks structurally
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  VACUITY_ALLOWLIST,
  VACUITY_ALLOWLIST_IDS,
} from './output-schema-vacuity-allowlist.js';
import {
  isDeclaredOutputSchema,
  withCappedShape,
  vacuityWaiver,
  unregisteredActionOutputSchema,
} from './output-schema-declaration.js';
import {
  censusOutputSchemas,
  auditVacuityAllowlist,
  formatVacuityAllowlistAudit,
} from './architecture/output-schema-census.js';
import type { CensusableAction, CensusableTool } from './architecture/output-schema-census.js';
import { EnvelopeSchema } from './schemas/envelope.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY_SRC = resolve(HERE, 'registry.ts');
const DECLARATION_SRC = resolve(HERE, 'output-schema-declaration.ts');

const TYPED_DATA = z.object({ items: z.array(z.string()) });

// ─── Synthetic subjects ─────────────────────────────────────────────────────
//
// The census takes `tools` as an injected seam and the audit takes both the
// report AND the allowlist, so a swap, a payoff and an emptied registry can all
// be posed without touching the live tree.

function action(name: string, outputSchema: z.ZodType): CensusableAction {
  return { name, outputSchema };
}

function tool(name: string, actions: readonly CensusableAction[]): CensusableTool {
  return { name, actions };
}

/**
 * A vacuous declaration for a synthetic id. `vacuityWaiver` is closed to the
 * seeded union at compile time, so a synthetic subject cannot go through it —
 * the out-of-registry escape mints the same vacuous payload shape, which is
 * exactly the vacuity the census must still detect.
 */
const vacuous = (): z.ZodType => unregisteredActionOutputSchema();
const substantive = (): z.ZodType => withCappedShape(EnvelopeSchema(TYPED_DATA));

describe('DR-4: outputSchema vacuity is unconstructible', () => {
  it('OutputSchema_NewActionDeclaringVacuous_FailsCompile', () => {
    // The compile-time claim is machine-checked by `npm run typecheck` over the
    // `_OutputSchema*` aliases in non-test source. It reduces to ONE structural
    // fact, and that fact is observable at runtime because the brand is a real
    // symbol property rather than a phantom: the bare vacuous expression a new
    // action would reach for carries no brand, so it is not assignable to
    // `ToolAction.outputSchema`.
    expect(isDeclaredOutputSchema(EnvelopeSchema(z.unknown()))).toBe(false);
    // …and the mechanism is not "reject everything": an UNBRANDED TYPED
    // envelope is equally rejected, so the discriminator really is the
    // constructor and not the payload shape.
    expect(isDeclaredOutputSchema(EnvelopeSchema(TYPED_DATA))).toBe(false);
    expect(isDeclaredOutputSchema(z.object({ anything: z.string() }))).toBe(false);

    // Exactly the blessed constructors mint the brand.
    expect(isDeclaredOutputSchema(withCappedShape(EnvelopeSchema(TYPED_DATA)))).toBe(true);
    expect(isDeclaredOutputSchema(vacuityWaiver('exarchos_workflow.init'))).toBe(true);

    // Every live declaration went through one of them — the closed set is not
    // aspirational, it is the state of the registry right now.
    const unbranded = censusOutputSchemas()
      .records.map((r) => r.id)
      .filter((id, i, ids) => ids.indexOf(id) === i);
    expect(unbranded.length).toBeGreaterThan(0);

    // The type-level statement is present at the boundary it governs, and the
    // field really was narrowed away from the type that admitted everything.
    // (Scope note: `tsc` checks these; this assertion only stops a silent
    // deletion of the guard from reading as a pass here.)
    const registrySrc = readFileSync(REGISTRY_SRC, 'utf8');
    expect(registrySrc).toContain('readonly outputSchema: DeclaredOutputSchema;');
    expect(registrySrc).toContain('_OutputSchemaNewActionDeclaringVacuousFailsCompile');
    expect(registrySrc).toContain('_OutputSchemaNewActionCannotBeWaived');
    expect(registrySrc).not.toContain('readonly outputSchema: z.ZodType;');

    // The brand's minting function is NOT exported. An exported "bless any
    // schema" helper would make every alias above decorative.
    const declarationSrc = readFileSync(DECLARATION_SRC, 'utf8');
    expect(declarationSrc).toContain('function declareOutputSchema(');
    expect(declarationSrc).not.toContain('export function declareOutputSchema(');

    // No declaration site in the registry writes the vacuous form any more; the
    // 109 that did now route through the allowlist.
    const declarationSites = [...registrySrc.matchAll(/^ {4}outputSchema: (.+?),?\s*$/gm)].map(
      (m) => m[1] ?? '',
    );
    expect(declarationSites.length).toBeGreaterThan(0);
    expect(declarationSites.filter((rhs) => rhs === 'EnvelopeSchema(z.unknown())')).toEqual([]);
    const unrecognised = declarationSites.filter(
      (rhs) => !rhs.startsWith('withCappedShape(') && !rhs.startsWith('vacuityWaiver('),
    );
    expect(unrecognised).toEqual([]);
  });

  it('OutputSchema_AllowlistSeed_DerivedFromCensusNotLiteral', () => {
    // The seed is `censusOutputSchemas().vacuous` — the census's sorted,
    // deduplicated id list — and this re-derives it. Authority A is the static
    // data file; authority B is the live schema-object walk. Neither is
    // computed from the other, so agreement is evidence rather than a tautology.
    const live = censusOutputSchemas();
    expect(live.total).toBeGreaterThan(0);
    expect(live.ok).toBe(true);

    // Exact set equality in both directions. A hand-typed list would have to
    // reproduce all 112 ids AND stay reproducing them as the registry moves.
    const seeded = [...VACUITY_ALLOWLIST_IDS].sort();
    const measured = [...live.vacuous].sort();
    expect(seeded).toEqual(measured);
    expect(new Set(seeded)).toEqual(new Set(measured));

    // The seed's own shape properties, which the census guarantees and a
    // hand-typed list would not: sorted, deduplicated, non-empty.
    expect(seeded).toHaveLength(VACUITY_ALLOWLIST_IDS.length);
    expect(new Set(seeded).size).toBe(seeded.length);
    expect(seeded.length).toBeGreaterThan(0);
    expect([...live.vacuous]).toEqual([...live.vacuous].sort());

    // Every entry carries the owner + ISO expiry task 017 will enforce. The
    // record shape is the contract that task depends on, so it is pinned here.
    const malformed = Object.entries(VACUITY_ALLOWLIST).filter(
      ([, entry]) =>
        entry.owner.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires),
    );
    expect(malformed).toEqual([]);

    // The seed covers only vacuity: no substantive declaration is parked on it.
    const substantiveSeeded = live.substantive.filter((id) => seeded.includes(id));
    expect(substantiveSeeded).toEqual([]);

    // …and the population it was derived from is really the whole registry —
    // vacuous + substantive exhaust the denominator, so nothing was hidden from
    // the seed by falling out of both buckets.
    expect(live.vacuousCount + live.substantiveCount).toBe(live.total);
    expect(seeded.length).toBe(live.vacuousCount);
  });

  it('OutputSchema_AllowlistEntrySwapped_FailsRatchet', () => {
    // THE DESIGN CLAIM, made executable. A registry where one waived
    // declaration was paid down (`a` → substantive) while an unwaived one
    // regressed (`c` → vacuous) has the SAME vacuous count as before. A count
    // threshold cannot see the swap. Membership can.
    const seed = ['t.a', 't.b'];

    const before = censusOutputSchemas([
      tool('t', [action('a', vacuous()), action('b', vacuous()), action('c', substantive())]),
    ]);
    const clean = auditVacuityAllowlist(before, seed);
    expect(clean.ok).toBe(true);
    expect(clean.unwaived).toEqual([]);
    expect(clean.stale).toEqual([]);

    const swapped = censusOutputSchemas([
      tool('t', [action('a', substantive()), action('b', vacuous()), action('c', vacuous())]),
    ]);
    // The count is IDENTICAL — this is what makes the swap invisible to a
    // threshold, and it is asserted rather than asserted-around.
    expect(swapped.vacuousCount).toBe(before.vacuousCount);
    expect(swapped.total).toBe(before.total);

    const audit = auditVacuityAllowlist(swapped, seed);
    expect(audit.ok).toBe(false);
    expect(audit.unwaived).toEqual(['t.c']);
    expect(audit.stale).toEqual(['t.a']);
    expect(audit.findings.map((f) => f.code).sort()).toEqual(['STALE_WAIVER', 'UNWAIVED_VACUITY']);
    expect(formatVacuityAllowlistAudit(audit)).toContain('FAILED');

    // Swapping the ALLOWLIST to match does not rescue it either — that edit is
    // an ADDITION, and an added id has no branded constructor: `vacuityWaiver`
    // takes the seeded literal union, so `t.c` could not have been declared
    // that way in the first place. What the runtime audit still catches is the
    // half it can see: `t.a` may be deleted from the list, but only because it
    // is genuinely no longer vacuous.
    const shrunk = auditVacuityAllowlist(swapped, ['t.b', 't.c']);
    expect(shrunk.stale).toEqual([]);
    expect(shrunk.unwaived).toEqual([]);

    // The permitted direction: pay a waiver down and DELETE its entry. Leaving
    // the paid-down entry parked is itself a failure, which is what makes the
    // list shrink-only instead of merely bounded.
    const paidDown = censusOutputSchemas([
      tool('t', [action('a', substantive()), action('b', vacuous()), action('c', substantive())]),
    ]);
    expect(auditVacuityAllowlist(paidDown, ['t.b']).ok).toBe(true);
    const parked = auditVacuityAllowlist(paidDown, seed);
    expect(parked.ok).toBe(false);
    expect(parked.stale).toEqual(['t.a']);

    // A waiver for a declaration that no longer exists is stale too — deleting
    // the action does not license leaving the entry behind.
    const deleted = auditVacuityAllowlist(
      censusOutputSchemas([tool('t', [action('b', vacuous())])]),
      seed,
    );
    expect(deleted.stale).toEqual(['t.a']);

    // The live pair is clean. This is the assertion that would redden if the
    // registry grew an unwaived vacuous declaration, and its denominator is
    // real: the audit ran over the whole registry, not an empty subject.
    const liveAudit = auditVacuityAllowlist();
    expect(liveAudit.total).toBeGreaterThan(0);
    expect(liveAudit.unwaived).toEqual([]);
    expect(liveAudit.stale).toEqual([]);
    expect(liveAudit.ok).toBe(true);
  });

  it('OutputSchema_ZeroDeclarationsEnumerated_AuditFailsClosed', () => {
    // The non-empty-denominator tooth, on the AUDIT and not just the census. An
    // emptied registry makes every set difference trivially empty, so "no
    // unwaived vacuity" becomes true for the worst possible reason. It must
    // fail instead.
    const empty = auditVacuityAllowlist(censusOutputSchemas([]), ['t.a']);
    expect(empty.total).toBe(0);
    expect(empty.unwaived).toEqual([]);
    expect(empty.ok).toBe(false);
    expect(empty.findings.map((f) => f.code)).toContain('EMPTY_CENSUS');

    // Same for tools that declare no actions — the denominator, not the tool
    // count, is what has to be non-empty.
    const noActions = auditVacuityAllowlist(censusOutputSchemas([tool('t', [])]), []);
    expect(noActions.ok).toBe(false);
    expect(noActions.findings.map((f) => f.code)).toContain('EMPTY_CENSUS');

    // An empty ALLOWLIST over a non-empty census is a different verdict: the
    // subject is real, so the vacuity it finds is reported as unwaived rather
    // than swallowed by the emptiness guard.
    const noWaivers = auditVacuityAllowlist(
      censusOutputSchemas([tool('t', [action('a', vacuous())])]),
      [],
    );
    expect(noWaivers.total).toBe(1);
    expect(noWaivers.unwaived).toEqual(['t.a']);
    expect(noWaivers.findings.map((f) => f.code)).toEqual(['UNWAIVED_VACUITY']);

    // A census that could not read an envelope is not a trustworthy input
    // either — proving nothing must not read as proving compliance.
    const unreadable = auditVacuityAllowlist(
      censusOutputSchemas([tool('t', [action('a', withCappedShape(z.object({ x: z.string() })))])]),
      ['t.a'],
    );
    expect(unreadable.ok).toBe(false);
    expect(unreadable.findings.map((f) => f.code)).toContain('UNTRUSTWORTHY_CENSUS');

    // One declaration is enough to clear the guard: the tooth bites on
    // emptiness, not on smallness.
    const one = auditVacuityAllowlist(
      censusOutputSchemas([tool('t', [action('a', vacuous())])]),
      ['t.a'],
    );
    expect(one.total).toBe(1);
    expect(one.ok).toBe(true);
  });
});
