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
// census; it cannot observe the data file. Authority C (task 060) is the FROZEN
// PIN `output-schema-seed-pin.ts` — prior state, recorded once, which likewise
// imports nothing and cannot observe either of the other two. Their agreement is
// the claim; their disagreement is the finding.
//
// @oracle-sources: ../../src/output-schema-vacuity-allowlist.ts, ../../tools/conformance/src/output-schema-seed-pin.ts, the Zod schema objects the live tool registry constructs at module-import time and the census walks structurally
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  VACUITY_ALLOWLIST,
  VACUITY_ALLOWLIST_IDS,
  VACUITY_RETIRED,
  VACUITY_RETIRED_IDS,
} from '../../src/output-schema-vacuity-allowlist.js';
import { VACUITY_SEED_KEY_SET_DIGEST } from '../../tools/conformance/src/output-schema-seed-pin.js';
import {
  isDeclaredOutputSchema,
  isExtensionOutputSchema,
  withCappedShape,
  vacuityWaiver,
  unregisteredActionOutputSchema,
} from '../../src/output-schema-declaration.js';
import {
  formatVacuityAllowlistAudit,
  formatVacuitySeedIntegrityAudit,
} from '../../tools/conformance/src/output-schema-census.js';
import {
  auditLiveVacuityAllowlist,
  auditLiveVacuityRatchet,
  auditLiveVacuitySeedIntegrity,
  censusLiveOutputSchemas,
  liveVacuitySeedDigest,
} from '../../tools/conformance/src/bindings/output-schema.js';
import type { CensusableAction, CensusableTool } from '../../tools/conformance/src/output-schema-census.js';
import { TOOL_REGISTRY } from '../../src/registry.js';
import { EnvelopeSchema } from '../../src/contract/schemas/envelope.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY_DIR = resolve(HERE, '../../src/registry');
const DECLARATION_SRC = resolve(HERE, '../../src/output-schema-declaration.ts');

/**
 * Every module of the registry, concatenated.
 *
 * The assertions below are claims about the DECLARATION SURFACE, not about one
 * file, so the corpus is enumerated from the directory rather than named as a
 * path. When the declarations lived in a single 4,587-line module a path was
 * the same thing as the surface; now it is not, and a test pinned to one file
 * would go quietly vacuous the next time a module is split out of it — passing
 * because it found nothing to object to. The `declarationSites.length`
 * assertion is the denominator that would catch an empty read.
 */
function readRegistrySources(dir = REGISTRY_DIR): string {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => {
      const full = resolve(dir, e.name);
      if (e.isDirectory()) return readRegistrySources(full);
      return e.name.endsWith('.ts') ? readFileSync(full, 'utf8') : '';
    })
    .join('\n');
}

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
    const unbranded = censusLiveOutputSchemas()
      .records.map((r) => r.id)
      .filter((id, i, ids) => ids.indexOf(id) === i);
    expect(unbranded.length).toBeGreaterThan(0);

    // The type-level statement is present at the boundary it governs, and the
    // field really was narrowed away from the type that admitted everything.
    // (Scope note: `tsc` checks these; this assertion only stops a silent
    // deletion of the guard from reading as a pass here.)
    const registrySrc = readRegistrySources();
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

  it('OutputSchema_RegistryActionUsingExtensionEscape_FailsCompile', () => {
    // TASK 060, HOLE 1. Task 055 closed the vacuous EXPRESSION but left
    // `unregisteredActionOutputSchema()` minting the SAME brand as the two
    // registry constructors, so a new REGISTRY action could call the
    // out-of-registry escape and compile. The audit still reported it
    // (UNWAIVED_VACUITY) — at run time, while DR-4 claims compile time.
    //
    // The compile-time claim itself is machine-checked by `npm run typecheck`
    // over `_OutputSchemaRegistryActionUsingExtensionEscapeFailsCompile` in
    // `registry.ts` and `_OutputSchemaExtensionEscapeIsNotDeclared` in
    // `output-schema-declaration.ts` — NON-TEST source, because the package
    // tsconfig excludes `*.test.ts`. What this test adds is the runtime-
    // observable half: the split is two distinct brand VALUES on a real symbol
    // property, so "these are different types" can be checked by looking.
    const escape = unregisteredActionOutputSchema();
    expect(isExtensionOutputSchema(escape)).toBe(true);
    expect(isDeclaredOutputSchema(escape)).toBe(false);

    // …and the split is not "the escape is branded, everything else isn't":
    // both registry constructors carry the OTHER brand, in both directions.
    const capped = withCappedShape(EnvelopeSchema(TYPED_DATA));
    const waived = vacuityWaiver('exarchos_workflow.init');
    expect(isDeclaredOutputSchema(capped)).toBe(true);
    expect(isExtensionOutputSchema(capped)).toBe(false);
    expect(isDeclaredOutputSchema(waived)).toBe(true);
    expect(isExtensionOutputSchema(waived)).toBe(false);

    // The live registry uses NONE of the escape today. This is the assertion
    // that reddens if a built-in declaration ever acquires the extension brand,
    // and its denominator is real rather than an empty filter.
    const live = TOOL_REGISTRY.flatMap((t) =>
      t.actions.map((a) => ({ id: `${t.name}.${a.name}`, schema: a.outputSchema })),
    );
    expect(live.length).toBeGreaterThan(100);
    expect(live.filter((a) => isExtensionOutputSchema(a.schema)).map((a) => a.id)).toEqual([]);
    expect(live.filter((a) => !isDeclaredOutputSchema(a.schema)).map((a) => a.id)).toEqual([]);

    // The `.exarchos.yml` surface was NOT closed by breaking it — closing the
    // registry path by making the escape unconstructible everywhere would pass
    // every assertion above and ship a regression. The escape still mints a
    // usable, vacuous, extension-branded envelope.
    const envelope = (data: unknown): unknown => ({
      success: true,
      data,
      next_actions: [],
      _meta: {},
      _perf: { ms: 1, bytes: 1, tokens: 1 },
    });
    expect(escape.safeParse(envelope({ anything: 'goes' })).success).toBe(true);
    expect(escape.safeParse(envelope(['and', 'so', 'does', 'this'])).success).toBe(true);
    // …and it is still exactly as vacuous as before, so the census and the
    // runtime ratchet keep seeing it — the nominal split changed WHO may call
    // the escape, not what it produces.
    expect(censusLiveOutputSchemas([tool('custom', [action('run', escape)])]).vacuous).toEqual([
      'custom.run',
    ]);

    // The type-level statements are present at the boundaries they govern, and
    // the registry does not so much as IMPORT the escape. (Scope note: `tsc`
    // checks the aliases; these assertions only stop a silent deletion of the
    // guard from reading as a pass here.)
    const registrySrc = readRegistrySources();
    expect(registrySrc).toContain('_OutputSchemaRegistryActionUsingExtensionEscapeFailsCompile');
    expect(registrySrc).toContain('_OutputSchemaExtensionActionIsNotABuiltinDeclaration');
    expect(registrySrc).toContain('_OutputSchemaRegistryDoorRejectsUnnarrowedTools');
    // The escape is not imported and not called anywhere in the registry — read
    // from the CODE lines only, so the prose that explains WHY it is absent is
    // not mistaken for a use of it.
    const registryCode = registrySrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    expect(registryCode.length).toBeGreaterThan(1000);
    expect(registryCode.filter((l) => l.includes('unregisteredActionOutputSchema'))).toEqual([]);
    // The positive half — without it the negatives would pass vacuously if a
    // field were narrowed to something nothing can produce, or if the extension
    // surface were "closed" by deleting it.
    expect(registrySrc).toContain('_OutputSchemaExtensionEscapeSatisfiesTheExtensionField');
    expect(registrySrc).toContain('_OutputSchemaCappedShapeSatisfiesTheField');
    expect(registrySrc).toContain('_OutputSchemaWaiverSatisfiesTheField');

    // The door is the registry constant, not a per-array annotation:
    // `TOOL_REGISTRY` and EVERY action array are declared with the narrowed
    // types, so an array of the wide `ToolAction` cannot be smuggled in.
    expect(registrySrc).toContain('export const TOOL_REGISTRY: readonly BuiltinCompositeTool[]');

    // Stated as "every array is narrow" rather than as a count. The count was
    // five when one array backed each of the five tools; the lists are now
    // split per action family, so a fixed number would have to be re-pinned on
    // every split — and re-pinning a number teaches nothing about whether the
    // door still holds. What holds the door is the TYPE, checked here on all of
    // them.
    const arrayDecls = [
      ...registrySrc.matchAll(/^(?:export )?const (\w+Actions): readonly (\w+)\[\] = \[/gm),
    ].map((m) => ({ name: m[1] ?? '', type: m[2] ?? '' }));

    // Denominator: a corpus that matched nothing would satisfy the filter below.
    expect(arrayDecls.length).toBeGreaterThanOrEqual(TOOL_REGISTRY.length);

    expect(
      arrayDecls.filter((d) => d.type !== 'BuiltinToolAction'),
      'every action array must be declared `readonly BuiltinToolAction[]` — a wide ' +
        '`ToolAction[]` array reaching the registry is the smuggling path this closes',
    ).toEqual([]);

    const declarationSrc = readFileSync(DECLARATION_SRC, 'utf8');
    expect(declarationSrc).toContain('_OutputSchemaExtensionEscapeIsNotDeclared');
    expect(declarationSrc).toContain('_OutputSchemaEscapeIsExtension');
    // The extension brand's minting function is no more exported than the
    // registry one — otherwise either brand could be forged onto any schema.
    expect(declarationSrc).toContain('function declareExtensionOutputSchema(');
    expect(declarationSrc).not.toContain('export function declareExtensionOutputSchema(');
  });

  it('OutputSchema_AllowlistIdSwappedInPlace_FailsTheShrinkOnlyCheck', () => {
    // TASK 060, HOLE 2 — the decision, made executable.
    //
    // Every check task 055 shipped compares the allowlist against TODAY. An
    // in-place swap moves both sides at once: pay `a` down, make `c` vacuous,
    // and edit the seed to drop `a` and add `c`. Membership agrees in both
    // directions, the count never moves, and the compile-time waiver union
    // accepts `c` because the union IS the file that was edited. "Only removals
    // happened" is not a statement about today; it needs PRIOR STATE.
    //
    // The pin in `output-schema-seed-pin.ts` is that prior state, and the
    // quantity it pins — ALLOWLIST ∪ RETIRED — is invariant under the one legal
    // edit, so it never has to be regenerated for legitimate work.

    // Baseline: the seed was {a, b}, nothing retired yet.
    const pinned = liveVacuitySeedDigest(['t.a', 't.b']);
    expect(auditLiveVacuitySeedIntegrity(['t.a', 't.b'], [], pinned).ok).toBe(true);

    // THE SWAP. `a` out, `c` in — same cardinality, and the membership audit is
    // clean against the swapped registry because both halves moved together.
    const swappedRegistry = censusLiveOutputSchemas([
      tool('t', [action('a', substantive()), action('b', vacuous()), action('c', vacuous())]),
    ]);
    const membership = auditLiveVacuityAllowlist(swappedRegistry, ['t.b', 't.c']);
    expect(membership.ok).toBe(true);
    expect(membership.unwaived).toEqual([]);
    expect(membership.stale).toEqual([]);
    expect(membership.waived).toHaveLength(2);

    // …and THAT is what the pin catches. Same count, different set.
    const swapped = auditLiveVacuitySeedIntegrity(['t.b', 't.c'], [], pinned);
    expect(swapped.ok).toBe(false);
    expect(swapped.keySetSize).toBe(2);
    expect(swapped.digest).not.toBe(pinned);
    expect(swapped.findings.map((f) => f.code)).toEqual(['SEED_KEY_SET_DRIFT']);
    expect(formatVacuitySeedIntegrityAudit(swapped)).toContain('FAILED');
    expect(formatVacuitySeedIntegrityAudit(swapped)).toContain('Do NOT regenerate the pin');

    // Composed, the ratchet fails even though its membership half is green —
    // this is the whole reason the two halves are not the same check.
    const composed = auditLiveVacuityRatchet(membership, swapped);
    expect(membership.ok).toBe(true);
    expect(composed.ok).toBe(false);
    expect(composed.findings.map((f) => f.code)).toEqual(['SEED_KEY_SET_DRIFT']);

    // THE LEGAL EDIT: pay `a` down and MOVE its entry to the graveyard. The
    // union is unchanged, so the pin is unchanged — the pin costs nothing on
    // the happy path, which is what stops it from becoming a regenerate ritual.
    const paidDown = auditLiveVacuitySeedIntegrity(['t.b'], ['t.a'], pinned);
    expect(paidDown.ok).toBe(true);
    expect(paidDown.digest).toBe(pinned);
    expect(paidDown.keySetSize).toBe(2);

    // Deleting instead of retiring destroys the prior state, so it fails too —
    // otherwise a swap could be spelled as delete-then-add across two commits.
    const deletedNotRetired = auditLiveVacuitySeedIntegrity(['t.b'], [], pinned);
    expect(deletedNotRetired.ok).toBe(false);
    expect(deletedNotRetired.findings.map((f) => f.code)).toEqual(['SEED_KEY_SET_DRIFT']);

    // Retiring an entry WITHOUT paying it down is not an escape from the
    // membership half: retired ids are not waivers, so the still-vacuous
    // declaration comes back as unwaived. The two halves only clear together.
    const retiredButUnfixed = auditLiveVacuityAllowlist(
      censusLiveOutputSchemas([tool('t', [action('a', vacuous()), action('b', vacuous())])]),
      ['t.b'],
    );
    expect(retiredButUnfixed.unwaived).toEqual(['t.a']);
    expect(retiredButUnfixed.ok).toBe(false);

    // An id parked in BOTH maps is absorbed by the set union, so it would be
    // invisible to the digest alone. It is its own finding.
    const both = auditLiveVacuitySeedIntegrity(['t.a', 't.b'], ['t.a'], pinned);
    expect(both.digest).toBe(pinned);
    expect(both.overlapping).toEqual(['t.a']);
    expect(both.ok).toBe(false);
    expect(both.findings.map((f) => f.code)).toEqual(['RETIRED_AND_WAIVED']);

    // The digest is over a SET: re-sorting the literal or writing an id twice
    // must not move it, or every reformat would look like tampering.
    expect(liveVacuitySeedDigest(['t.b', 't.a'])).toBe(pinned);
    expect(liveVacuitySeedDigest(['t.a', 't.b', 't.a'])).toBe(pinned);
    expect(liveVacuitySeedDigest(['t.a'])).not.toBe(pinned);

    // THE LIVE TRIPLE. The seed is 112 ids across the two maps, it hashes to the
    // frozen pin, and the pin is a literal in a module that imports nothing —
    // it cannot have been computed from what it is checking.
    const liveSeed = auditLiveVacuitySeedIntegrity();
    expect(liveSeed.keySetSize).toBe(
      new Set([...VACUITY_ALLOWLIST_IDS, ...VACUITY_RETIRED_IDS]).size,
    );
    expect(liveSeed.keySetSize).toBe(112);
    expect(liveSeed.pinnedDigest).toBe(VACUITY_SEED_KEY_SET_DIGEST);
    expect(liveSeed.findings).toEqual([]);
    expect(liveSeed.ok).toBe(true);

    // THE MECHANISM, EXERCISED FOR REAL. Task 069 performed the first paydown,
    // so the graveyard is no longer empty — and the digest above is UNCHANGED,
    // which is the property the whole design rests on. A paydown MOVES an id
    // between the two maps; the union, and therefore the pin, is invariant.
    expect(Object.keys(VACUITY_RETIRED)).toEqual([
      'exarchos_orchestrate.check_invariant_conformance',
    ]);
    expect(VACUITY_ALLOWLIST_IDS).not.toContain(
      'exarchos_orchestrate.check_invariant_conformance',
    );
    // …and the retired id is genuinely paid down, not parked: the membership
    // half would report it `UNWAIVED_VACUITY` if its schema were still vacuous.
    expect(censusLiveOutputSchemas().substantive).toContain(
      'exarchos_orchestrate.check_invariant_conformance',
    );

    // Retired entries carry the owner + ISO paydown date. The shape predicate is
    // pinned against constructed entries in BOTH directions first, so the
    // filter below is a real test rather than an empty `every()`.
    const retirementShape = (entry: { owner: string; retiredAt: string }): boolean =>
      entry.owner.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(entry.retiredAt);
    expect(retirementShape({ owner: 'views', retiredAt: '2026-08-07' })).toBe(true);
    expect(retirementShape({ owner: '', retiredAt: '2026-08-07' })).toBe(false);
    expect(retirementShape({ owner: 'views', retiredAt: 'soon' })).toBe(false);
    expect(Object.values(VACUITY_RETIRED).length).toBeGreaterThan(0);
    expect(
      Object.values(VACUITY_RETIRED).filter((entry) => !retirementShape(entry)),
    ).toEqual([]);

    // And the whole ratchet is green against the live triple.
    expect(auditLiveVacuityRatchet().ok).toBe(true);
  });

  it('OutputSchema_AllowlistSeed_DerivedFromCensusNotLiteral', () => {
    // The seed is `censusLiveOutputSchemas().vacuous` — the census's sorted,
    // deduplicated id list — and this re-derives it. Authority A is the static
    // data file; authority B is the live schema-object walk. Neither is
    // computed from the other, so agreement is evidence rather than a tautology.
    const live = censusLiveOutputSchemas();
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

    const before = censusLiveOutputSchemas([
      tool('t', [action('a', vacuous()), action('b', vacuous()), action('c', substantive())]),
    ]);
    const clean = auditLiveVacuityAllowlist(before, seed);
    expect(clean.ok).toBe(true);
    expect(clean.unwaived).toEqual([]);
    expect(clean.stale).toEqual([]);

    const swapped = censusLiveOutputSchemas([
      tool('t', [action('a', substantive()), action('b', vacuous()), action('c', vacuous())]),
    ]);
    // The count is IDENTICAL — this is what makes the swap invisible to a
    // threshold, and it is asserted rather than asserted-around.
    expect(swapped.vacuousCount).toBe(before.vacuousCount);
    expect(swapped.total).toBe(before.total);

    const audit = auditLiveVacuityAllowlist(swapped, seed);
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
    const shrunk = auditLiveVacuityAllowlist(swapped, ['t.b', 't.c']);
    expect(shrunk.stale).toEqual([]);
    expect(shrunk.unwaived).toEqual([]);

    // The permitted direction: pay a waiver down and DELETE its entry. Leaving
    // the paid-down entry parked is itself a failure, which is what makes the
    // list shrink-only instead of merely bounded.
    const paidDown = censusLiveOutputSchemas([
      tool('t', [action('a', substantive()), action('b', vacuous()), action('c', substantive())]),
    ]);
    expect(auditLiveVacuityAllowlist(paidDown, ['t.b']).ok).toBe(true);
    const parked = auditLiveVacuityAllowlist(paidDown, seed);
    expect(parked.ok).toBe(false);
    expect(parked.stale).toEqual(['t.a']);

    // A waiver for a declaration that no longer exists is stale too — deleting
    // the action does not license leaving the entry behind.
    const deleted = auditLiveVacuityAllowlist(
      censusLiveOutputSchemas([tool('t', [action('b', vacuous())])]),
      seed,
    );
    expect(deleted.stale).toEqual(['t.a']);

    // The live pair is clean. This is the assertion that would redden if the
    // registry grew an unwaived vacuous declaration, and its denominator is
    // real: the audit ran over the whole registry, not an empty subject.
    const liveAudit = auditLiveVacuityAllowlist();
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
    const empty = auditLiveVacuityAllowlist(censusLiveOutputSchemas([]), ['t.a']);
    expect(empty.total).toBe(0);
    expect(empty.unwaived).toEqual([]);
    expect(empty.ok).toBe(false);
    expect(empty.findings.map((f) => f.code)).toContain('EMPTY_CENSUS');

    // Same for tools that declare no actions — the denominator, not the tool
    // count, is what has to be non-empty.
    const noActions = auditLiveVacuityAllowlist(censusLiveOutputSchemas([tool('t', [])]), []);
    expect(noActions.ok).toBe(false);
    expect(noActions.findings.map((f) => f.code)).toContain('EMPTY_CENSUS');

    // An empty ALLOWLIST over a non-empty census is a different verdict: the
    // subject is real, so the vacuity it finds is reported as unwaived rather
    // than swallowed by the emptiness guard.
    const noWaivers = auditLiveVacuityAllowlist(
      censusLiveOutputSchemas([tool('t', [action('a', vacuous())])]),
      [],
    );
    expect(noWaivers.total).toBe(1);
    expect(noWaivers.unwaived).toEqual(['t.a']);
    expect(noWaivers.findings.map((f) => f.code)).toEqual(['UNWAIVED_VACUITY']);

    // A census that could not read an envelope is not a trustworthy input
    // either — proving nothing must not read as proving compliance.
    const unreadable = auditLiveVacuityAllowlist(
      censusLiveOutputSchemas([tool('t', [action('a', withCappedShape(z.object({ x: z.string() })))])]),
      ['t.a'],
    );
    expect(unreadable.ok).toBe(false);
    expect(unreadable.findings.map((f) => f.code)).toContain('UNTRUSTWORTHY_CENSUS');

    // One declaration is enough to clear the guard: the tooth bites on
    // emptiness, not on smallness.
    const one = auditLiveVacuityAllowlist(
      censusLiveOutputSchemas([tool('t', [action('a', vacuous())])]),
      ['t.a'],
    );
    expect(one.total).toBe(1);
    expect(one.ok).toBe(true);
  });
});
