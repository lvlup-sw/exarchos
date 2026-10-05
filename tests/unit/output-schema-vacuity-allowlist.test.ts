// Policy tests for `outputSchema` vacuity. A new action cannot declare a vacuous schema. The seeded
// vacuous declarations are an allowlist that can only shrink.
//
// Compile time: `outputSchema` accepts only a branded schema from `withCappedShape` or
// `vacuityWaiver`. `Expect<...>` aliases in non-test source state that claim, because the package
// tsconfig excludes `*.test.ts`. This file checks the brand at run time, as a real symbol property.
// Run time: `auditVacuityAllowlist` compares the allowlist with the live census in each direction.
// A count threshold cannot see a swap.
//
// Three authorities, and none reads another. The data file `output-schema-vacuity-allowlist.ts`
// imports nothing. The census walks the Zod schema objects of the live registry. The frozen pin
// `output-schema-seed-pin.ts` records the prior state.
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
 * Reads each `.ts` module under the registry directory and joins the text. The assertions are
 * claims about the declaration surface, so the corpus comes from the directory and not from one
 * path. A test pinned to one file passes with nothing to check after a module split. The
 * `declarationSites.length` assertion catches an empty read.
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

/**
 * Builds a synthetic action. The census takes `tools` as a parameter, and the audit takes the
 * report and the allowlist. Thus a test can pose a swap, a paydown or an empty registry without
 * the live tree.
 */
function action(name: string, outputSchema: z.ZodType): CensusableAction {
  return { name, outputSchema };
}

function tool(name: string, actions: readonly CensusableAction[]): CensusableTool {
  return { name, actions };
}

/**
 * A vacuous declaration for a synthetic id. `vacuityWaiver` accepts only the seeded ids at compile
 * time, so a synthetic subject uses the out-of-registry escape. The escape gives the same vacuous
 * payload shape, which the census must still detect.
 */
const vacuous = (): z.ZodType => unregisteredActionOutputSchema();
const substantive = (): z.ZodType => withCappedShape(EnvelopeSchema(TYPED_DATA));

describe('DR-4: outputSchema vacuity is unconstructible', () => {
  /**
   * `npm run typecheck` checks the compile-time claim through the `_OutputSchema*` aliases in
   * non-test source. This test checks the same fact at run time. A bare envelope has no brand,
   * typed or not, and only the two registry constructors give one.
   *
   * The source-text assertions only stop a silent deletion of the aliases. The function that
   * attaches the brand must not be exported, or any schema can get the brand. Each declaration
   * site in the registry must call `withCappedShape` or `vacuityWaiver`.
   */
  it('OutputSchema_NewActionDeclaringVacuous_FailsCompile', () => {
    expect(isDeclaredOutputSchema(EnvelopeSchema(z.unknown()))).toBe(false);
    expect(isDeclaredOutputSchema(EnvelopeSchema(TYPED_DATA))).toBe(false);
    expect(isDeclaredOutputSchema(z.object({ anything: z.string() }))).toBe(false);

    expect(isDeclaredOutputSchema(withCappedShape(EnvelopeSchema(TYPED_DATA)))).toBe(true);
    expect(isDeclaredOutputSchema(vacuityWaiver('exarchos_workflow.init'))).toBe(true);

    const unbranded = censusLiveOutputSchemas()
      .records.map((r) => r.id)
      .filter((id, i, ids) => ids.indexOf(id) === i);
    expect(unbranded.length).toBeGreaterThan(0);

    const registrySrc = readRegistrySources();
    expect(registrySrc).toContain('readonly outputSchema: DeclaredOutputSchema;');
    expect(registrySrc).toContain('_OutputSchemaNewActionDeclaringVacuousFailsCompile');
    expect(registrySrc).toContain('_OutputSchemaNewActionCannotBeWaived');
    expect(registrySrc).not.toContain('readonly outputSchema: z.ZodType;');

    const declarationSrc = readFileSync(DECLARATION_SRC, 'utf8');
    expect(declarationSrc).toContain('function declareOutputSchema(');
    expect(declarationSrc).not.toContain('export function declareOutputSchema(');

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

  /**
   * The out-of-registry escape has its own brand, so a registry action that calls it fails
   * `npm run typecheck`. This test checks the two brand values at run time, in each direction.
   *
   * - No live registry declaration has the extension brand, and no registry code line names the
   *   escape.
   * - The escape still gives a usable vacuous envelope for `.exarchos.yml` tools, and the census
   *   still classifies it as vacuous.
   * - `TOOL_REGISTRY` and each action array have the narrowed type. The test checks each array and
   *   not a count, because the count changes with each split of an action family.
   */
  it('OutputSchema_RegistryActionUsingExtensionEscape_FailsCompile', () => {
    const escape = unregisteredActionOutputSchema();
    expect(isExtensionOutputSchema(escape)).toBe(true);
    expect(isDeclaredOutputSchema(escape)).toBe(false);

    const capped = withCappedShape(EnvelopeSchema(TYPED_DATA));
    const waived = vacuityWaiver('exarchos_workflow.init');
    expect(isDeclaredOutputSchema(capped)).toBe(true);
    expect(isExtensionOutputSchema(capped)).toBe(false);
    expect(isDeclaredOutputSchema(waived)).toBe(true);
    expect(isExtensionOutputSchema(waived)).toBe(false);

    const live = TOOL_REGISTRY.flatMap((t) =>
      t.actions.map((a) => ({ id: `${t.name}.${a.name}`, schema: a.outputSchema })),
    );
    expect(live.length).toBeGreaterThan(100);
    expect(live.filter((a) => isExtensionOutputSchema(a.schema)).map((a) => a.id)).toEqual([]);
    expect(live.filter((a) => !isDeclaredOutputSchema(a.schema)).map((a) => a.id)).toEqual([]);

    const envelope = (data: unknown): unknown => ({
      success: true,
      data,
      next_actions: [],
      _meta: {},
      _perf: { ms: 1, bytes: 1, tokens: 1 },
    });
    expect(escape.safeParse(envelope({ anything: 'goes' })).success).toBe(true);
    expect(escape.safeParse(envelope(['and', 'so', 'does', 'this'])).success).toBe(true);
    expect(censusLiveOutputSchemas([tool('custom', [action('run', escape)])]).vacuous).toEqual([
      'custom.run',
    ]);

    const registrySrc = readRegistrySources();
    expect(registrySrc).toContain('_OutputSchemaRegistryActionUsingExtensionEscapeFailsCompile');
    expect(registrySrc).toContain('_OutputSchemaExtensionActionIsNotABuiltinDeclaration');
    expect(registrySrc).toContain('_OutputSchemaRegistryDoorRejectsUnnarrowedTools');
    const registryCode = registrySrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    expect(registryCode.length).toBeGreaterThan(1000);
    expect(registryCode.filter((l) => l.includes('unregisteredActionOutputSchema'))).toEqual([]);
    expect(registrySrc).toContain('_OutputSchemaExtensionEscapeSatisfiesTheExtensionField');
    expect(registrySrc).toContain('_OutputSchemaCappedShapeSatisfiesTheField');
    expect(registrySrc).toContain('_OutputSchemaWaiverSatisfiesTheField');

    expect(registrySrc).toContain('export const TOOL_REGISTRY: readonly BuiltinCompositeTool[]');

    const arrayDecls = [
      ...registrySrc.matchAll(/^(?:export )?const (\w+Actions): readonly (\w+)\[\] = \[/gm),
    ].map((m) => ({ name: m[1] ?? '', type: m[2] ?? '' }));

    expect(arrayDecls.length).toBeGreaterThanOrEqual(TOOL_REGISTRY.length);

    expect(
      arrayDecls.filter((d) => d.type !== 'BuiltinToolAction'),
      'every action array must be declared `readonly BuiltinToolAction[]` — a wide ' +
        '`ToolAction[]` array reaching the registry is the smuggling path this closes',
    ).toEqual([]);

    const declarationSrc = readFileSync(DECLARATION_SRC, 'utf8');
    expect(declarationSrc).toContain('_OutputSchemaExtensionEscapeIsNotDeclared');
    expect(declarationSrc).toContain('_OutputSchemaEscapeIsExtension');
    expect(declarationSrc).toContain('function declareExtensionOutputSchema(');
    expect(declarationSrc).not.toContain('export function declareExtensionOutputSchema(');
  });

  /**
   * An in-place swap pays `a` down, makes `c` vacuous, and edits the seed to match. Membership
   * then agrees in each direction, and the count does not move. Only prior state shows the swap.
   *
   * The pin in `output-schema-seed-pin.ts` is the digest of the allowlist ids and the retired ids.
   * A legal paydown moves an id from the first map to the second, so the pin does not change. A
   * deletion with no retirement fails, and an id in the two maps is its own finding.
   *
   * A retired id keeps the key that the seed gave it. `currentIdOf` maps `stack_place` to its
   * current tool, because the live census uses the current id.
   */
  it('OutputSchema_AllowlistIdSwappedInPlace_FailsTheShrinkOnlyCheck', () => {
    const pinned = liveVacuitySeedDigest(['t.a', 't.b']);
    expect(auditLiveVacuitySeedIntegrity(['t.a', 't.b'], [], pinned).ok).toBe(true);

    const swappedRegistry = censusLiveOutputSchemas([
      tool('t', [action('a', substantive()), action('b', vacuous()), action('c', vacuous())]),
    ]);
    const membership = auditLiveVacuityAllowlist(swappedRegistry, ['t.b', 't.c']);
    expect(membership.ok).toBe(true);
    expect(membership.unwaived).toEqual([]);
    expect(membership.stale).toEqual([]);
    expect(membership.waived).toHaveLength(2);

    const swapped = auditLiveVacuitySeedIntegrity(['t.b', 't.c'], [], pinned);
    expect(swapped.ok).toBe(false);
    expect(swapped.keySetSize).toBe(2);
    expect(swapped.digest).not.toBe(pinned);
    expect(swapped.findings.map((f) => f.code)).toEqual(['SEED_KEY_SET_DRIFT']);
    expect(formatVacuitySeedIntegrityAudit(swapped)).toContain('FAILED');
    expect(formatVacuitySeedIntegrityAudit(swapped)).toContain('Do NOT regenerate the pin');

    const composed = auditLiveVacuityRatchet(membership, swapped);
    expect(membership.ok).toBe(true);
    expect(composed.ok).toBe(false);
    expect(composed.findings.map((f) => f.code)).toEqual(['SEED_KEY_SET_DRIFT']);

    const paidDown = auditLiveVacuitySeedIntegrity(['t.b'], ['t.a'], pinned);
    expect(paidDown.ok).toBe(true);
    expect(paidDown.digest).toBe(pinned);
    expect(paidDown.keySetSize).toBe(2);

    const deletedNotRetired = auditLiveVacuitySeedIntegrity(['t.b'], [], pinned);
    expect(deletedNotRetired.ok).toBe(false);
    expect(deletedNotRetired.findings.map((f) => f.code)).toEqual(['SEED_KEY_SET_DRIFT']);

    const retiredButUnfixed = auditLiveVacuityAllowlist(
      censusLiveOutputSchemas([tool('t', [action('a', vacuous()), action('b', vacuous())])]),
      ['t.b'],
    );
    expect(retiredButUnfixed.unwaived).toEqual(['t.a']);
    expect(retiredButUnfixed.ok).toBe(false);

    const both = auditLiveVacuitySeedIntegrity(['t.a', 't.b'], ['t.a'], pinned);
    expect(both.digest).toBe(pinned);
    expect(both.overlapping).toEqual(['t.a']);
    expect(both.ok).toBe(false);
    expect(both.findings.map((f) => f.code)).toEqual(['RETIRED_AND_WAIVED']);

    expect(liveVacuitySeedDigest(['t.b', 't.a'])).toBe(pinned);
    expect(liveVacuitySeedDigest(['t.a', 't.b', 't.a'])).toBe(pinned);
    expect(liveVacuitySeedDigest(['t.a'])).not.toBe(pinned);

    const liveSeed = auditLiveVacuitySeedIntegrity();
    expect(liveSeed.keySetSize).toBe(
      new Set([...VACUITY_ALLOWLIST_IDS, ...VACUITY_RETIRED_IDS]).size,
    );
    expect(liveSeed.keySetSize).toBe(112);
    expect(liveSeed.pinnedDigest).toBe(VACUITY_SEED_KEY_SET_DIGEST);
    expect(liveSeed.findings).toEqual([]);
    expect(liveSeed.ok).toBe(true);

    const retiredIds: readonly string[] = [
      'exarchos_orchestrate.check_invariant_conformance',
      'exarchos_orchestrate.cutover_decide',
      'exarchos_orchestrate.cutover_readiness',
      'exarchos_view.stack_place',
    ];
    expect([...Object.keys(VACUITY_RETIRED)].sort()).toEqual([...retiredIds].sort());

    const currentIdOf = (retiredId: string): string =>
      retiredId === 'exarchos_view.stack_place' ? 'exarchos_orchestrate.stack_place' : retiredId;

    for (const id of retiredIds) {
      expect(VACUITY_ALLOWLIST_IDS).not.toContain(id);
      expect(censusLiveOutputSchemas().substantive).toContain(currentIdOf(id));
    }

    const retirementShape = (entry: { owner: string; retiredAt: string }): boolean =>
      entry.owner.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(entry.retiredAt);
    expect(retirementShape({ owner: 'views', retiredAt: '2026-08-07' })).toBe(true);
    expect(retirementShape({ owner: '', retiredAt: '2026-08-07' })).toBe(false);
    expect(retirementShape({ owner: 'views', retiredAt: 'soon' })).toBe(false);
    expect(Object.values(VACUITY_RETIRED).length).toBeGreaterThan(0);
    expect(
      Object.values(VACUITY_RETIRED).filter((entry) => !retirementShape(entry)),
    ).toEqual([]);

    expect(auditLiveVacuityRatchet().ok).toBe(true);
  });

  /**
   * The seed must equal `censusLiveOutputSchemas().vacuous`. The static data file and the live
   * schema walk are separate authorities, so the agreement is evidence.
   *
   * Each entry has an owner and an ISO expiry date. No substantive declaration is in the seed. The
   * vacuous and substantive counts sum to the total, so no declaration is outside the two buckets.
   */
  it('OutputSchema_AllowlistSeed_DerivedFromCensusNotLiteral', () => {
    const live = censusLiveOutputSchemas();
    expect(live.total).toBeGreaterThan(0);
    expect(live.ok).toBe(true);

    const seeded = [...VACUITY_ALLOWLIST_IDS].sort();
    const measured = [...live.vacuous].sort();
    expect(seeded).toEqual(measured);
    expect(new Set(seeded)).toEqual(new Set(measured));

    expect(seeded).toHaveLength(VACUITY_ALLOWLIST_IDS.length);
    expect(new Set(seeded).size).toBe(seeded.length);
    expect(seeded.length).toBeGreaterThan(0);
    expect([...live.vacuous]).toEqual([...live.vacuous].sort());

    const malformed = Object.entries(VACUITY_ALLOWLIST).filter(
      ([, entry]) =>
        entry.owner.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires),
    );
    expect(malformed).toEqual([]);

    const substantiveSeeded = live.substantive.filter((id) => seeded.includes(id));
    expect(substantiveSeeded).toEqual([]);

    expect(live.vacuousCount + live.substantiveCount).toBe(live.total);
    expect(seeded.length).toBe(live.vacuousCount);
  });

  /**
   * The registry pays down one waived declaration (`a`), and an unwaived one (`c`) becomes vacuous.
   * The vacuous count is the same, so a count threshold cannot see the swap. Membership can.
   *
   * The membership audit accepts an allowlist that an author edits to match the swap. The seed
   * digest in `OutputSchema_AllowlistIdSwappedInPlace_FailsTheShrinkOnlyCheck` catches that edit.
   * A paid-down entry that stays on the list is stale, and so is a waiver for an action that does
   * not exist.
   */
  it('OutputSchema_AllowlistEntrySwapped_FailsRatchet', () => {
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
    expect(swapped.vacuousCount).toBe(before.vacuousCount);
    expect(swapped.total).toBe(before.total);

    const audit = auditLiveVacuityAllowlist(swapped, seed);
    expect(audit.ok).toBe(false);
    expect(audit.unwaived).toEqual(['t.c']);
    expect(audit.stale).toEqual(['t.a']);
    expect(audit.findings.map((f) => f.code).sort()).toEqual(['STALE_WAIVER', 'UNWAIVED_VACUITY']);
    expect(formatVacuityAllowlistAudit(audit)).toContain('FAILED');

    const shrunk = auditLiveVacuityAllowlist(swapped, ['t.b', 't.c']);
    expect(shrunk.stale).toEqual([]);
    expect(shrunk.unwaived).toEqual([]);

    const paidDown = censusLiveOutputSchemas([
      tool('t', [action('a', substantive()), action('b', vacuous()), action('c', substantive())]),
    ]);
    expect(auditLiveVacuityAllowlist(paidDown, ['t.b']).ok).toBe(true);
    const parked = auditLiveVacuityAllowlist(paidDown, seed);
    expect(parked.ok).toBe(false);
    expect(parked.stale).toEqual(['t.a']);

    const deleted = auditLiveVacuityAllowlist(
      censusLiveOutputSchemas([tool('t', [action('b', vacuous())])]),
      seed,
    );
    expect(deleted.stale).toEqual(['t.a']);

    const liveAudit = auditLiveVacuityAllowlist();
    expect(liveAudit.total).toBeGreaterThan(0);
    expect(liveAudit.unwaived).toEqual([]);
    expect(liveAudit.stale).toEqual([]);
    expect(liveAudit.ok).toBe(true);
  });

  /**
   * An empty registry makes each set difference empty, so the audit must fail and not report
   * compliance. The denominator is the declaration count, so a tool with no actions fails too. One
   * declaration clears the guard.
   *
   * An empty allowlist over a real census reports the vacuity as unwaived. The audit also fails
   * for a census that cannot read an envelope. That fixture uses `vacuityWaiver`, because
   * `withCappedShape` refuses a schema that is not an envelope.
   */
  it('OutputSchema_ZeroDeclarationsEnumerated_AuditFailsClosed', () => {
    const empty = auditLiveVacuityAllowlist(censusLiveOutputSchemas([]), ['t.a']);
    expect(empty.total).toBe(0);
    expect(empty.unwaived).toEqual([]);
    expect(empty.ok).toBe(false);
    expect(empty.findings.map((f) => f.code)).toContain('EMPTY_CENSUS');

    const noActions = auditLiveVacuityAllowlist(censusLiveOutputSchemas([tool('t', [])]), []);
    expect(noActions.ok).toBe(false);
    expect(noActions.findings.map((f) => f.code)).toContain('EMPTY_CENSUS');

    const noWaivers = auditLiveVacuityAllowlist(
      censusLiveOutputSchemas([tool('t', [action('a', vacuous())])]),
      [],
    );
    expect(noWaivers.total).toBe(1);
    expect(noWaivers.unwaived).toEqual(['t.a']);
    expect(noWaivers.findings.map((f) => f.code)).toEqual(['UNWAIVED_VACUITY']);

    const unreadable = auditLiveVacuityAllowlist(
      censusLiveOutputSchemas([
        tool('t', [action('a', vacuityWaiver('exarchos_workflow.init', z.object({ x: z.string() })))]),
      ]),
      ['t.a'],
    );
    expect(unreadable.ok).toBe(false);
    expect(unreadable.findings.map((f) => f.code)).toContain('UNTRUSTWORTHY_CENSUS');

    const one = auditLiveVacuityAllowlist(
      censusLiveOutputSchemas([tool('t', [action('a', vacuous())])]),
      ['t.a'],
    );
    expect(one.total).toBe(1);
    expect(one.ok).toBe(true);
  });
});
