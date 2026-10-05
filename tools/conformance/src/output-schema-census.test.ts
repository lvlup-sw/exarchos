// `outputSchema` vacuity census over the tool registry. `outputSchema` records presence, not
// substance: an action can attach a schema that accepts every payload.
//
// These tests pin four facts. The counts derive from the enumerated subject. An empty subject is a
// failure. A schema that pins a real `data` shape is substantive. A vacuous schema stays vacuous
// behind a named binding.
//
// Two authorities. The expected classification comes from the declaration form in the registry
// source text. The census verdict comes from a walk of the Zod schema objects. Source text cannot
// see through a named binding, and the object walk cannot see syntax.
//
// @oracle-sources: ../../../src/registry.ts, the Zod schema objects the live tool registry constructs at module-import time and the census walks structurally
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import ts from 'typescript';
import { fromSubjectSrc } from './subject-root.js';
import {
  classifyOutputSchema,
  countByReason,
  formatOutputSchemaCensus,
} from './output-schema-census.js';
import type { CensusableAction, CensusableTool } from './output-schema-census.js';
import {
  censusLiveOutputSchemas,
  OUTPUT_SCHEMA_PORTS,
} from './bindings/output-schema.js';
import { acceptsEveryValue } from '../../../src/contract/schemas/schema-totality.js';
import { TOOL_REGISTRY } from '../../../src/registry.js';
import { EnvelopeSchema } from '../../../src/contract/schemas/envelope.js';

/**
 * The declaration surface: the whole `registry/` tree. The declarations sit in a module for each
 * action family, so a single path reads only part of the authority. The shared `describe` actions
 * come from factories beside the action lists, so a scan of `actions/` alone misses them.
 * `OutputSchemaCensus_ZeroDeclarationsEnumerated_FailsClosed` catches a total loss.
 */
const REGISTRY_DIR = fromSubjectSrc('registry');

function readRegistryActionSources(dir = REGISTRY_DIR): string {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => {
      const abs = join(dir, e.name);
      if (e.isDirectory()) return readRegistryActionSources(abs);
      return e.name.endsWith('.ts') ? readFileSync(abs, 'utf8') : '';
    })
    .join('\n');
}

interface DeclarationSite {
  /** Action name this `outputSchema:` belongs to. */
  readonly action: string;
  /** Right-hand side, whitespace-collapsed, for example `EnvelopeSchema(z.unknown())`. */
  readonly rhs: string;
  /** Callee when the RHS is a direct call, for example `vacuityWaiver`. */
  readonly callee: string | undefined;
  /** Argument count of that call. Distinguishes a waiver carrying a named binding. */
  readonly argCount: number;
}

/** The property name of an object-literal member, quoted or not. */
function memberName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

/**
 * Authority A: the declaration sites, read from the syntax tree of the registry source. A site is
 * an `outputSchema:` property assignment in an object literal, paired with the `name:` of the same
 * literal. The read does not depend on indent or line shape. The `ToolAction.outputSchema`
 * interface field is a property signature, not an assignment, so the read excludes it.
 */
function readDeclarationSites(): readonly DeclarationSite[] {
  const source = readRegistryActionSources();
  const sourceFile = ts.createSourceFile(
    'registry-tree.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const sites: DeclarationSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      let action: string | undefined;
      let declared: ts.Expression | undefined;
      for (const member of node.properties) {
        if (!ts.isPropertyAssignment(member)) continue;
        const key = memberName(member.name);
        if (key === 'name' && ts.isStringLiteralLike(member.initializer)) {
          action = member.initializer.text;
        } else if (key === 'outputSchema') {
          declared = member.initializer;
        }
      }
      if (declared !== undefined) {
        const call = ts.isCallExpression(declared) ? declared : undefined;
        sites.push({
          action: action ?? '<unknown>',
          rhs: declared.getText(sourceFile).replace(/\s+/g, ' ').trim(),
          callee:
            call !== undefined && ts.isIdentifier(call.expression)
              ? call.expression.text
              : undefined,
          argCount: call?.arguments.length ?? 0,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return sites;
}

/** The literal spelling of vacuity. It does not typecheck at a declaration site. */
const LITERAL_VACUOUS_RHS = 'EnvelopeSchema(z.unknown())';
/** The sole substantive constructor. */
const isCappedShapeRhs = (site: DeclarationSite): boolean => site.callee === 'withCappedShape';
/** The allowlist escape — vacuity, declared against an owned, expiring entry. */
const isWaiverRhs = (site: DeclarationSite): boolean => site.callee === 'vacuityWaiver';
/**
 * A waiver with an explicit schema argument: vacuity through a named binding, not the default
 * envelope. A source-text detector that looks only for the literal vacuous expression scores
 * these as typed.
 */
const isNamedBindingRhs = (site: DeclarationSite): boolean =>
  isWaiverRhs(site) && site.argCount >= 2;

/**
 * Builds a synthetic action for the injected `tools` seam. The seam is `CensusableTool`, not
 * `CompositeTool`, because `ToolAction.outputSchema` takes a branded type. The census must accept
 * the raw `z.ZodType` subjects below, because it classifies vacuity that skipped the blessed
 * constructors.
 */
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
  /**
   * The counts must move with the enumerated subject across distinct compositions, and equal the
   * partition sizes, so no third bucket hides a declaration. A constant-returning implementation
   * gives one value for every composition. On the live registry, the denominator is the
   * enumerated action count.
   */
  it('OutputSchemaCensus_VacuousDeclarations_AreDerivedNotLiteral', () => {
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
      const report = censusLiveOutputSchemas(composition.tools);
      expect(report.total).toBe(composition.total);
      expect(report.vacuousCount).toBe(composition.vacuous);
      expect(report.substantiveCount).toBe(composition.substantive);
      expect(report.vacuous).toHaveLength(composition.vacuous);
      expect(report.substantive).toHaveLength(composition.substantive);
      expect(report.vacuousCount + report.substantiveCount).toBe(report.total);
      expect(report.records).toHaveLength(composition.total);
    }

    const measured = compositions.map((c) => censusLiveOutputSchemas(c.tools).vacuousCount);
    expect(new Set(measured).size).toBeGreaterThan(1);

    const live = censusLiveOutputSchemas();
    const liveActions = TOOL_REGISTRY.reduce((n, t) => n + t.actions.length, 0);
    expect(live.total).toBe(liveActions);
    expect(live.vacuousCount + live.substantiveCount).toBe(live.total);
    expect(live.vacuousCount).not.toBe(compositions[0]?.vacuous);
  });

  /**
   * An empty subject must fail with `EMPTY_CENSUS`, because "0 vacuous" there is the instrument
   * dying green. Tools with no actions are also an empty subject. One declaration clears the guard.
   * Both authorities confirm that the live subject is not empty.
   */
  it('OutputSchemaCensus_ZeroDeclarationsEnumerated_FailsClosed', () => {
    const noTools = censusLiveOutputSchemas([]);
    expect(noTools.total).toBe(0);
    expect(noTools.ok).toBe(false);
    expect(noTools.diagnostics.map((d) => d.code)).toContain('EMPTY_CENSUS');

    const emptyTools = censusLiveOutputSchemas([tool('t1', []), tool('t2', [])]);
    expect(emptyTools.total).toBe(0);
    expect(emptyTools.ok).toBe(false);
    expect(emptyTools.diagnostics.map((d) => d.code)).toContain('EMPTY_CENSUS');

    const oneDeclaration = censusLiveOutputSchemas([tool('t', [action('a', VACUOUS_ENVELOPE)])]);
    expect(oneDeclaration.total).toBe(1);
    expect(oneDeclaration.ok).toBe(true);
    expect(oneDeclaration.diagnostics).toHaveLength(0);

    const live = censusLiveOutputSchemas();
    expect(live.total).toBeGreaterThan(0);
    expect(live.ok).toBe(true);
    expect(readDeclarationSites().length).toBeGreaterThan(0);
  });

  /**
   * A typed declaration must never land in the vacuous bucket. The actions that the source spells
   * `withCappedShape(...)` must equal the substantive set of the census. A typed `data` stays
   * substantive after the capped-shape union. `z.unknown()` and `z.any()` are both vacuous.
   */
  it('OutputSchemaCensus_TypedDeclarations_ClassifiedSubstantive', () => {
    expect(classifyOutputSchema(TYPED_ENVELOPE, OUTPUT_SCHEMA_PORTS)).toEqual({
      classification: 'substantive',
      reason: 'typed-data',
    });

    const cappedFromSource = readDeclarationSites()
      .filter((s) => isCappedShapeRhs(s))
      .map((s) => s.action);
    const substantiveFromCensus = censusLiveOutputSchemas()
      .records.filter((r) => r.classification === 'substantive')
      .map((r) => r.action);

    expect(cappedFromSource.length).toBeGreaterThan(0);
    expect(new Set(substantiveFromCensus)).toEqual(new Set(cappedFromSource));
    expect(substantiveFromCensus).toHaveLength(cappedFromSource.length);

    const capped = EnvelopeSchema(
      z.union([z.object({ items: z.array(z.string()) }), z.object({ summary: z.string() })]),
    );
    expect(classifyOutputSchema(capped, OUTPUT_SCHEMA_PORTS).classification).toBe('substantive');

    expect(acceptsEveryValue(z.unknown())).toBe(true);
    expect(acceptsEveryValue(z.any())).toBe(true);
    expect(acceptsEveryValue(z.object({ items: z.array(z.string()) }))).toBe(false);
    expect(
      classifyOutputSchema(EnvelopeSchema(z.any()), OUTPUT_SCHEMA_PORTS).classification,
    ).toBe('vacuous');
  });

  /**
   * A named binding hides the vacuous expression from a grep, but the census reads the schema
   * object. An intersection that constrains only `_meta` leaves `data` vacuous. Each live
   * declaration that reaches vacuity through a named binding must count as vacuous. If one becomes
   * typed, re-derive the reconciled counts in the live-registry test.
   */
  it('OutputSchemaCensus_AliasedVacuousSchema_CountedVacuous', () => {
    expect(classifyOutputSchema(ALIASED_VACUOUS_ENVELOPE, OUTPUT_SCHEMA_PORTS)).toEqual({
      classification: 'vacuous',
      reason: 'unknown-data',
    });

    expect(classifyOutputSchema(WRAPPED_VACUOUS_ENVELOPE, OUTPUT_SCHEMA_PORTS)).toEqual({
      classification: 'vacuous',
      reason: 'wrapped-unknown-data',
    });

    const namedBindings = readDeclarationSites().filter((s) => isNamedBindingRhs(s));
    expect(namedBindings.length).toBeGreaterThan(0);

    const byAction = new Map(censusLiveOutputSchemas().records.map((r) => [r.action, r]));
    for (const site of namedBindings) {
      expect(byAction.get(site.action)?.classification).toBe('vacuous');
    }
    expect(byAction.get('transition')?.reason).toBe('wrapped-unknown-data');
    expect(byAction.get('update')?.reason).toBe('unknown-data');
  });

  /**
   * A shape that the census cannot walk is not evidence of substance. So the census counts an
   * unreadable envelope as vacuous and raises `UNREADABLE_OUTPUT_SCHEMA`. No live declaration
   * trips this today.
   */
  it('OutputSchemaCensus_UnreadableEnvelope_FailsClosed', () => {
    const alien = z.object({ whatever: z.string() });
    expect(classifyOutputSchema(alien, OUTPUT_SCHEMA_PORTS)).toEqual({
      classification: 'vacuous',
      reason: 'unreadable-envelope',
    });

    const report = censusLiveOutputSchemas([tool('t', [action('a', alien)])]);
    expect(report.ok).toBe(false);
    expect(report.vacuousCount).toBe(1);
    expect(report.diagnostics.map((d) => d.code)).toContain('UNREADABLE_OUTPUT_SCHEMA');

    expect(countByReason(censusLiveOutputSchemas())['unreadable-envelope']).toBe(0);
  });

  /**
   * The live counts are measured, and they reconcile against the source-text authority. Every site
   * is a `vacuityWaiver` or a `withCappedShape`, and two waivers carry a named binding.
   * `makeDescribeAction()` serves two tools from one site, so the registry builds one extra action.
   * Vacuous is the waivers plus that extra action. Substantive is the capped sites.
   *
   * A paydown moves the split, and a new action moves the denominator. The allowlist is
   * shrink-only, so a new action can only arrive capped. The paid-down ids are named, because the
   * sums also balance if a different declaration moves. The rendered report must state its
   * denominator.
   */
  it('OutputSchemaCensus_LiveRegistry_ReportsMeasuredVacuousCount', () => {
    const report = censusLiveOutputSchemas();
    const sites = readDeclarationSites();
    const literalVacuousSites = sites.filter((s) => s.rhs === LITERAL_VACUOUS_RHS).length;
    const cappedSites = sites.filter((s) => isCappedShapeRhs(s)).length;
    const waiverSites = sites.filter((s) => isWaiverRhs(s)).length;
    const namedBindingSites = sites.filter((s) => isNamedBindingRhs(s)).length;

    expect(sites).toHaveLength(waiverSites + cappedSites);
    expect(literalVacuousSites).toBe(0);
    expect(waiverSites).toBe(107);
    expect(cappedSites).toBe(19);
    expect(waiverSites + cappedSites).toBe(126);
    expect(namedBindingSites).toBe(2);

    const factoryDuplicates = report.total - sites.length;
    expect(factoryDuplicates).toBe(1);

    expect(report.vacuousCount).toBe(waiverSites + factoryDuplicates);
    expect(report.substantiveCount).toBe(cappedSites);

    expect(report.total).toBe(127);
    expect(report.vacuousCount).toBe(108);
    expect(report.substantiveCount).toBe(19);
    expect(countByReason(report)).toEqual({
      'unknown-data': 107,
      'wrapped-unknown-data': 1,
      'typed-data': 19,
      'unreadable-envelope': 0,
    });

    for (const id of [
      'exarchos_orchestrate.check_invariant_conformance',
      'exarchos_orchestrate.cutover_decide',
      'exarchos_orchestrate.cutover_readiness',
    ]) {
      expect(report.substantive).toContain(id);
      expect(report.vacuous).not.toContain(id);
    }

    const rendered = formatOutputSchemaCensus(report);
    expect(rendered).toContain(
      `${report.vacuousCount} vacuous of ${report.total} declarations`,
    );
    expect(rendered).toContain(`${report.substantiveCount} substantive`);

    expect(report.vacuous).toHaveLength(report.vacuousCount);
    expect(new Set(report.vacuous).size).toBe(report.vacuousCount);
    expect([...report.vacuous]).toEqual([...report.vacuous].sort());
    expect([...report.substantive]).toEqual([...report.substantive].sort());
  });
});

/**
 * Totality is a property of what a schema admits, not of its outermost node. `withCappedShape`
 * wraps `data` in a union, so a check of the outer class can miss an open member. The oracle is a
 * parse of each schema against a probe set, and the predicate must agree with it. A `.catch()`
 * accepts every value, because it swallows every failure. An intersection must satisfy both sides,
 * so one open side does not make it total.
 */
describe('acceptsEveryValue — totality is semantic, not spelling', () => {
  const PROBES: readonly unknown[] = [{ a: 1 }, 'str', 42, null, [1, 2], true, undefined];
  const admitsEveryProbe = (schema: z.ZodType): boolean =>
    PROBES.every((probe) => schema.safeParse(probe).success);

  const TOTAL_FORMS: ReadonlyArray<readonly [string, z.ZodType]> = [
    ['bare unknown', z.unknown()],
    ['bare any', z.any()],
    ['union carrying unknown (the withCappedShape shape)', z.union([z.unknown(), z.object({ truncated: z.boolean() })])],
    ['union carrying unknown beside a typed member', z.union([z.unknown(), z.string()])],
    ['optional unknown', z.unknown().optional()],
    ['nullable any', z.any().nullable()],
    ['readonly unknown', z.unknown().readonly()],
    ['defaulted unknown', z.unknown().default(1)],
    ['caught string', z.string().catch('x')],
  ];

  const CONSTRAINED_FORMS: ReadonlyArray<readonly [string, z.ZodType]> = [
    ['string', z.string()],
    ['object with a typed field', z.object({ a: z.string() })],
    ['union of typed members', z.union([z.string(), z.number()])],
    ['intersection of unknown and string', z.intersection(z.unknown(), z.string())],
  ];

  it.each(TOTAL_FORMS)('acceptsEveryValue_%s_IsTotal', (_label, schema) => {
    expect(admitsEveryProbe(schema)).toBe(true);
    expect(acceptsEveryValue(schema)).toBe(true);
  });

  it.each(CONSTRAINED_FORMS)('acceptsEveryValue_%s_IsNotTotal', (_label, schema) => {
    expect(admitsEveryProbe(schema)).toBe(false);
    expect(acceptsEveryValue(schema)).toBe(false);
  });

  /** The laundered shape, built by hand, so the test does not need `withCappedShape` to build it. */
  it('classifyOutputSchema_EnvelopeOverATotalUnion_IsVacuous', () => {
    const laundered = EnvelopeSchema(
      z.union([z.unknown(), z.object({ truncated: z.boolean() })]),
    );
    expect(classifyOutputSchema(laundered, OUTPUT_SCHEMA_PORTS)).toMatchObject({ classification: 'vacuous' });
  });

  /** Stacked wrappers stay under the depth ceiling, and the check still finds the open branch. */
  it('acceptsEveryValue_DeeplyNestedTotalBranch_TerminatesAndIsTotal', () => {
    const nested = z.union([z.unknown().optional().nullable().readonly(), z.string()]);
    expect(admitsEveryProbe(nested)).toBe(true);
    expect(acceptsEveryValue(nested)).toBe(true);
  });
});
