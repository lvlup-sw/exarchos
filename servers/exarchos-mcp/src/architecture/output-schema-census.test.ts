// DR-4 (task 016): `outputSchema` vacuity census over the tool registry.
//
// The census exists because `outputSchema` records presence, not substance:
// nearly every registered action attaches `EnvelopeSchema(z.unknown())`, which
// is total over every payload shape including the wrong ones. These tests pin
// four things the census must never lose:
//
//   1. the counts are DERIVED from the enumerated subject, never literals;
//   2. an EMPTY subject is a FAILURE, not a clean run (the non-empty-denominator
//      guard — without it, a lost registry reads green);
//   3. a schema that pins a real `data` shape is classified substantive;
//   4. a vacuous schema stays vacuous even when a named binding hides the
//      literal `EnvelopeSchema(z.unknown())` text from a source grep.
//
// TWO AUTHORITIES. The expected classification is never read back out of the
// census. It is derived independently from the DECLARATION FORM in the
// `registry.ts` SOURCE TEXT — which spelling each action wrote — and compared
// against the census's verdict, which is computed by walking the Zod schema
// OBJECTS the registry constructs at import time. The two reads are independent
// by construction: source text cannot see through a named binding, and the
// object walk cannot see syntax. Where they disagree is exactly the finding
// this census was built to expose, and that disagreement is pinned below rather
// than smoothed over.
//
// @oracle-sources: ../registry.ts, the Zod schema objects the live tool registry constructs at module-import time and the census walks structurally
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  censusOutputSchemas,
  classifyOutputSchema,
  countByReason,
  formatOutputSchemaCensus,
  acceptsEveryValue,
} from './output-schema-census.js';
import type { CensusableAction, CensusableTool } from './output-schema-census.js';
import { TOOL_REGISTRY } from '../registry.js';
import { EnvelopeSchema } from '../schemas/envelope.js';

// ─── Authority A — the declaration form, read from registry source text ──────
//
// A declaration site is an `outputSchema:` property at object-literal depth
// (four-space indent). That deliberately excludes the `outputSchema`
// occurrences in `registry.ts` that are NOT declarations (the `ToolAction`
// interface field, at two-space indent). Each site is paired with the nearest
// preceding action `name:` at the same depth.
//
// DR-4 task 055 changed the SPELLING this authority reads, not what it means.
// Vacuity is now unconstructible: `ToolAction.outputSchema` takes a branded
// schema, so the 109 sites that wrote `EnvelopeSchema(z.unknown())` literally
// now route through `vacuityWaiver('<id>')` and the 10 typed ones still spell
// `withCappedShape(...)`. The two declarations that reach vacuity through a
// NAMED BINDING pass it as the waiver's second argument, so the source form
// still distinguishes them — which is what keeps the "aliased vacuity" finding
// auditable from the source side rather than only from the object walk.

const REGISTRY_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../registry.ts');

interface DeclarationSite {
  /** Action name this `outputSchema:` belongs to. */
  readonly action: string;
  /** Verbatim right-hand side, e.g. `EnvelopeSchema(z.unknown())`. */
  readonly rhs: string;
}

function readDeclarationSites(): readonly DeclarationSite[] {
  const sites: DeclarationSite[] = [];
  let currentName = '<unknown>';
  for (const line of readFileSync(REGISTRY_SRC, 'utf8').split('\n')) {
    const named = /^ {4}name: '([^']+)'/.exec(line);
    if (named?.[1] !== undefined) {
      currentName = named[1];
      continue;
    }
    const declared = /^ {4}outputSchema: (.+?),?\s*$/.exec(line);
    if (declared?.[1] !== undefined) {
      sites.push({ action: currentName, rhs: declared[1].replace(/,$/, '') });
    }
  }
  return sites;
}

/** The pre-DR-4 spelling of vacuity. No declaration site may use it any more. */
const LITERAL_VACUOUS_RHS = 'EnvelopeSchema(z.unknown())';
/** The sole substantive constructor. */
const isCappedShapeRhs = (rhs: string): boolean => rhs.startsWith('withCappedShape(');
/** The allowlist escape — vacuity, declared against an owned, expiring entry. */
const isWaiverRhs = (rhs: string): boolean => rhs.startsWith('vacuityWaiver(');
/**
 * A waiver carrying an explicit schema argument: vacuity reached through a
 * NAMED BINDING rather than the default envelope. These are the declarations a
 * source-text detector would score as typed if it only looked for the literal
 * vacuous expression.
 */
const isNamedBindingRhs = (rhs: string): boolean => isWaiverRhs(rhs) && rhs.includes(', ');

// ─── Synthetic registry fixtures ─────────────────────────────────────────────
//
// The census takes `tools` as an injected seam (the `description-budget.ts`
// idiom), so composition can be varied without touching the live registry. The
// seam is `CensusableTool`, NOT `CompositeTool`: since DR-4 task 055 narrowed
// `ToolAction.outputSchema` to a branded type, a seam typed `CompositeTool`
// would refuse the raw `z.ZodType` subjects below — and refusing them is
// exactly wrong for a detector whose job is to classify vacuity that arrived
// WITHOUT going through the blessed constructors.

function action(name: string, outputSchema: z.ZodType): CensusableAction {
  return { name, outputSchema };
}

function tool(name: string, actions: readonly CensusableAction[]): CensusableTool {
  return { name, actions };
}

/** A schema that pins a real `data` shape — the migration template. */
const TYPED_ENVELOPE = EnvelopeSchema(z.object({ items: z.array(z.string()) }));
/** The vacuous form, written literally. */
const VACUOUS_ENVELOPE = EnvelopeSchema(z.unknown());
/** The vacuous form reached through a named binding — invisible to a text grep. */
const ALIASED_VACUOUS_ENVELOPE = VACUOUS_ENVELOPE;
/** Vacuous `data` behind an intersection wrapper that constrains `_meta` only. */
const WRAPPED_VACUOUS_ENVELOPE = EnvelopeSchema(z.unknown()).and(
  z
    .object({ _meta: z.object({ deprecation: z.string().optional() }).passthrough().optional() })
    .passthrough(),
);

describe('DR-4: outputSchema vacuity census', () => {
  it('OutputSchemaCensus_VacuousDeclarations_AreDerivedNotLiteral', () => {
    // A census whose numbers are literals reports the same figure regardless of
    // what it enumerated. The proof of derivation is that the counts MOVE, in
    // lockstep, when the enumerated subject changes — across several distinct
    // compositions, none of which matches the live registry's numbers.
    const compositions: ReadonlyArray<{
      tools: readonly CensusableTool[];
      total: number;
      vacuous: number;
      substantive: number;
    }> = [
      {
        tools: [tool('t', [action('a', VACUOUS_ENVELOPE)])],
        total: 1,
        vacuous: 1,
        substantive: 0,
      },
      {
        tools: [tool('t', [action('a', TYPED_ENVELOPE)])],
        total: 1,
        vacuous: 0,
        substantive: 1,
      },
      {
        tools: [
          tool('t1', [
            action('a', VACUOUS_ENVELOPE),
            action('b', VACUOUS_ENVELOPE),
            action('c', TYPED_ENVELOPE),
          ]),
          tool('t2', [action('d', VACUOUS_ENVELOPE), action('e', TYPED_ENVELOPE)]),
        ],
        total: 5,
        vacuous: 3,
        substantive: 2,
      },
      {
        tools: [
          tool('t', [
            action('a', TYPED_ENVELOPE),
            action('b', TYPED_ENVELOPE),
            action('c', TYPED_ENVELOPE),
            action('d', WRAPPED_VACUOUS_ENVELOPE),
          ]),
        ],
        total: 4,
        vacuous: 1,
        substantive: 3,
      },
    ];

    for (const composition of compositions) {
      const report = censusOutputSchemas(composition.tools);
      expect(report.total).toBe(composition.total);
      expect(report.vacuousCount).toBe(composition.vacuous);
      expect(report.substantiveCount).toBe(composition.substantive);
      // The counts are exactly the partition sizes — no third bucket can hide
      // declarations from the denominator.
      expect(report.vacuous).toHaveLength(composition.vacuous);
      expect(report.substantive).toHaveLength(composition.substantive);
      expect(report.vacuousCount + report.substantiveCount).toBe(report.total);
      expect(report.records).toHaveLength(composition.total);
    }

    // Distinct compositions must yield distinct counts; a constant-returning
    // implementation collapses them to one value.
    const measured = compositions.map((c) => censusOutputSchemas(c.tools).vacuousCount);
    expect(new Set(measured).size).toBeGreaterThan(1);

    // The same derivation holds on the live registry: the partition is
    // exhaustive and the denominator is the enumerated action count.
    const live = censusOutputSchemas();
    const liveActions = TOOL_REGISTRY.reduce((n, t) => n + t.actions.length, 0);
    expect(live.total).toBe(liveActions);
    expect(live.vacuousCount + live.substantiveCount).toBe(live.total);
    expect(live.vacuousCount).not.toBe(compositions[0]?.vacuous);
  });

  it('OutputSchemaCensus_ZeroDeclarationsEnumerated_FailsClosed', () => {
    // The non-empty-denominator guard. A moved module, a broken import, or an
    // emptied registry all present the census with zero declarations. Reporting
    // "0 vacuous — clean" there would be the instrument silently dying green,
    // so an empty subject MUST fail.
    const noTools = censusOutputSchemas([]);
    expect(noTools.total).toBe(0);
    expect(noTools.ok).toBe(false);
    expect(noTools.diagnostics.map((d) => d.code)).toContain('EMPTY_CENSUS');

    // Tools present but declaring no actions is the same empty denominator.
    const emptyTools = censusOutputSchemas([tool('t1', []), tool('t2', [])]);
    expect(emptyTools.total).toBe(0);
    expect(emptyTools.ok).toBe(false);
    expect(emptyTools.diagnostics.map((d) => d.code)).toContain('EMPTY_CENSUS');

    // A single declaration is enough to clear the guard — the tooth bites only
    // on emptiness, not on smallness.
    const oneDeclaration = censusOutputSchemas([tool('t', [action('a', VACUOUS_ENVELOPE)])]);
    expect(oneDeclaration.total).toBe(1);
    expect(oneDeclaration.ok).toBe(true);
    expect(oneDeclaration.diagnostics).toHaveLength(0);

    // The live registry is a live subject — this is what proves the census has
    // something real to measure rather than an accidentally-empty one. The
    // second authority independently confirms the subject is non-empty: the
    // registry source really does carry declaration sites.
    const live = censusOutputSchemas();
    expect(live.total).toBeGreaterThan(0);
    expect(live.ok).toBe(true);
    expect(readDeclarationSites().length).toBeGreaterThan(0);
  });

  it('OutputSchemaCensus_TypedDeclarations_ClassifiedSubstantive', () => {
    // The typed declarations are the migration template every vacuous one is
    // meant to grow into. They must never be swept into the vacuous bucket.
    expect(classifyOutputSchema(TYPED_ENVELOPE)).toEqual({
      classification: 'substantive',
      reason: 'typed-data',
    });

    // Cross-authority check. Authority A: every action whose registry SOURCE
    // spells its declaration `withCappedShape(...)` — the only form on the live
    // tree that supplies a real `data` shape. Authority B: the census's verdict,
    // computed from the Zod objects. Neither side is read from the other.
    const cappedFromSource = readDeclarationSites()
      .filter((s) => isCappedShapeRhs(s.rhs))
      .map((s) => s.action);
    const substantiveFromCensus = censusOutputSchemas()
      .records.filter((r) => r.classification === 'substantive')
      .map((r) => r.action);

    expect(cappedFromSource.length).toBeGreaterThan(0);
    expect(new Set(substantiveFromCensus)).toEqual(new Set(cappedFromSource));
    expect(substantiveFromCensus).toHaveLength(cappedFromSource.length);

    // A typed `data` survives the capped-shape widening: unioning the summary
    // fallback into `data` must not read as a return to vacuity.
    const capped = EnvelopeSchema(
      z.union([z.object({ items: z.array(z.string()) }), z.object({ summary: z.string() })]),
    );
    expect(classifyOutputSchema(capped).classification).toBe('substantive');

    // The counterpart to the template: `z.unknown()` and `z.any()` are the two
    // structural escape hatches, and BOTH are vacuous. Classifying only the
    // first would leave a trivially reachable evasion.
    expect(acceptsEveryValue(z.unknown())).toBe(true);
    expect(acceptsEveryValue(z.any())).toBe(true);
    expect(acceptsEveryValue(z.object({ items: z.array(z.string()) }))).toBe(false);
    expect(classifyOutputSchema(EnvelopeSchema(z.any())).classification).toBe('vacuous');
  });

  it('OutputSchemaCensus_AliasedVacuousSchema_CountedVacuous', () => {
    // The evasion a source-text detector cannot see: bind the vacuous
    // expression to a name and the grep goes quiet while the contract stays
    // exactly total over every shape. The census reads the schema object, so
    // the alias resolves to the same verdict.
    expect(classifyOutputSchema(ALIASED_VACUOUS_ENVELOPE)).toEqual({
      classification: 'vacuous',
      reason: 'unknown-data',
    });

    // Same for an intersection wrapper: constraining `_meta` adds substance to
    // a DIFFERENT field. The payload contract is untouched, so `data` is still
    // vacuous — reported apart so the gap stays auditable.
    expect(classifyOutputSchema(WRAPPED_VACUOUS_ENVELOPE)).toEqual({
      classification: 'vacuous',
      reason: 'wrapped-unknown-data',
    });

    // THE FINDING, made executable. Authority A enumerates the live
    // declarations whose source reaches vacuity through a NAMED binding rather
    // than the plain envelope. A detector that only knew the literal vacuous
    // expression would score those typed. Authority B walks their schema
    // objects and finds `data` is still `z.unknown()`. Every one of them must be
    // counted vacuous; if a future change makes one genuinely typed, this
    // assertion fails and the reconciled arithmetic below has to be re-derived
    // rather than quietly drifting.
    const namedBindings = readDeclarationSites().filter((s) => isNamedBindingRhs(s.rhs));
    expect(namedBindings.length).toBeGreaterThan(0);

    const byAction = new Map(censusOutputSchemas().records.map((r) => [r.action, r]));
    for (const site of namedBindings) {
      expect(byAction.get(site.action)?.classification).toBe('vacuous');
    }
    expect(byAction.get('transition')?.reason).toBe('wrapped-unknown-data');
    expect(byAction.get('update')?.reason).toBe('unknown-data');
  });

  it('OutputSchemaCensus_UnreadableEnvelope_FailsClosed', () => {
    // A shape the census cannot walk is not evidence of substance. Proving
    // nothing must not read as proving typedness, so an unreadable envelope is
    // counted vacuous AND raised — the census reports itself untrustworthy.
    const alien = z.object({ whatever: z.string() });
    expect(classifyOutputSchema(alien)).toEqual({
      classification: 'vacuous',
      reason: 'unreadable-envelope',
    });

    const report = censusOutputSchemas([tool('t', [action('a', alien)])]);
    expect(report.ok).toBe(false);
    expect(report.vacuousCount).toBe(1);
    expect(report.diagnostics.map((d) => d.code)).toContain('UNREADABLE_OUTPUT_SCHEMA');

    // No live declaration trips this today — the census understands every
    // envelope shape currently registered.
    expect(countByReason(censusOutputSchemas())['unreadable-envelope']).toBe(0);
  });

  it('OutputSchemaCensus_LiveRegistry_ReportsMeasuredVacuousCount', () => {
    // DR-4 requires the census to report the live vacuous count on
    // introduction — that count is its proof of a live subject. The figures
    // below were MEASURED, not chosen, and they RECONCILE against the
    // independent source-text authority rather than restating the census.
    const report = censusOutputSchemas();
    const sites = readDeclarationSites();
    const literalVacuousSites = sites.filter((s) => s.rhs === LITERAL_VACUOUS_RHS).length;
    const cappedSites = sites.filter((s) => isCappedShapeRhs(s.rhs)).length;
    const waiverSites = sites.filter((s) => isWaiverRhs(s.rhs)).length;
    const namedBindingSites = sites.filter((s) => isNamedBindingRhs(s.rhs)).length;

    // Authority A: what the source spells. 111 allowlist waivers + 10
    // withCappedShape = 121 declaration sites, and the two forms are
    // EXHAUSTIVE — DR-4 task 055 left no third spelling. The literal vacuous
    // expression is extinct at declaration sites because it no longer
    // typechecks there, which is the acceptance criterion restated from the
    // source side.
    expect(sites).toHaveLength(waiverSites + cappedSites);
    expect(literalVacuousSites).toBe(0);
    expect(waiverSites).toBe(111);
    expect(cappedSites).toBe(10);
    // Two of the waivers carry an explicit named binding — the aliased vacuity
    // this census exists to see through.
    expect(namedBindingSites).toBe(2);

    // Authority B: what the registry actually builds. One MORE action than
    // there are declaration sites, because `makeDescribeAction()` is a factory
    // invoked for two composite tools while occupying a single source site.
    const factoryDuplicates = report.total - sites.length;
    expect(factoryDuplicates).toBe(1);

    // The reconciliation. Semantic vacuity = every waived site plus the extra
    // runtime instance the factory mints. Substantive = exactly the
    // withCappedShape sites. The two authorities are computed from different
    // things — the source spelling and the Zod object walk — and still land on
    // the same partition.
    expect(report.vacuousCount).toBe(waiverSites + factoryDuplicates);
    expect(report.substantiveCount).toBe(cappedSites);

    // The measured figures, pinned so drift shows up as a diff, not silence.
    expect(report.total).toBe(122);
    expect(report.vacuousCount).toBe(112);
    expect(report.substantiveCount).toBe(10);
    expect(countByReason(report)).toEqual({
      'unknown-data': 111,
      'wrapped-unknown-data': 1,
      'typed-data': 10,
      'unreadable-envelope': 0,
    });

    // The rendered report states the count against its denominator. A share
    // without a denominator is the rubber stamp this instrument removes.
    const rendered = formatOutputSchemaCensus(report);
    expect(rendered).toContain('112 vacuous of 122 declarations');
    expect(rendered).toContain('10 substantive');

    // The seed the ratchet consumes is a stable, sorted, deduplicated id list.
    expect(report.vacuous).toHaveLength(report.vacuousCount);
    expect(new Set(report.vacuous).size).toBe(report.vacuousCount);
    expect([...report.vacuous]).toEqual([...report.vacuous].sort());
    expect([...report.substantive]).toEqual([...report.substantive].sort());
  });
});
