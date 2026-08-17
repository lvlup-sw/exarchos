// ────────────────────────────────────────────────────────────────────────────
// DR-30: the delivery population is derived from the import graph — the modules
// holding a one-hop edge to `channel/delivery.ts` — and checked against the
// audit's own verdict over that population. The two are independent: the import
// graph does not know what the audit requires, and the audit does not choose
// its own subjects. Task 079 replaced a transcribed two-element constant whose
// test asserted that the constant contained what the constant declared, which
// is a comparison with itself and cannot fail.
// @oracle-sources: ./delivery-safety.ts, the one-hop import graph resolved from source
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  findSilentSwallows,
  maskLiteralsAndComments,
  auditDeliverySafety,
  resolveRequiredDeliveryModules,
  DELIVERY_CONTRACT_MODULE,
} from './delivery-safety.js';
import { SUBJECT_SRC_ROOT } from './subject-root.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';
import { lexModule } from '../../test-helpers/module-lexer.js';

/** The census's own fixtures, which moved into this package with it. */
const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

describe('findSilentSwallows — detection', () => {
  it('flags a bare empty catch block', () => {
    const findings = findSilentSwallows(
      `
      async function push() {
        try { await send(); } catch {}
      }
    `,
      lexModule,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('empty-catch');
  });

  it('flags an empty catch with a bound binding', () => {
    const findings = findSilentSwallows(`try { x(); } catch (e) {\n  // ignore\n}`, lexModule);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('empty-catch');
  });

  it('flags empty .catch() handler forms', () => {
    const findings = findSilentSwallows(
      `
      send().catch(() => {});
      send().catch((e) => {});
      send().catch(e => {});
      send().catch(async () => {});
      send().catch(() => undefined);
    `,
      lexModule,
    );
    expect(findings.filter((f) => f.kind === 'empty-catch-handler')).toHaveLength(5);
  });
});

describe('findSilentSwallows — no false positives', () => {
  it('does NOT flag a catch that handles the error', () => {
    const findings = findSilentSwallows(
      `
      try { await send(); } catch (e) { return failed(e); }
      other().catch((e) => log(e));
    `,
      lexModule,
    );
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag "catch {}" inside a comment or string', () => {
    const findings = findSilentSwallows(
      `
      // never write catch {}
      /* an empty catch {} is banned */
      const doc = "avoid catch {} here";
      const tmpl = \`also catch {} in a template\`;
      try { work(); } catch (e) { handle(e); }
    `,
      lexModule,
    );
    expect(findings).toHaveLength(0);
  });
});

describe('maskLiteralsAndComments', () => {
  it('preserves length and newlines while blanking literal/comment content', () => {
    const src = `a // comment\n"string"`;
    const masked = maskLiteralsAndComments(src, lexModule);
    expect(masked.length).toBe(src.length);
    expect(masked.split('\n')).toHaveLength(2);
    expect(masked).not.toContain('comment');
    expect(masked).not.toContain('string');
    expect(masked.startsWith('a ')).toBe(true);
  });
});

describe('auditDeliverySafety — live required-delivery modules', () => {
  it('the real required-delivery modules contain zero silent swallows', async () => {
    const result = await auditDeliverySafety(SUBJECT_SRC_ROOT, lexModule);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    // The verdict ranged over a real population, not an empty one.
    expect(result.modules.length).toBeGreaterThan(0);
  });

  it('DeliveryPopulation_IsDerivedFromTheImportGraph_NotTranscribed', async () => {
    // The superseded assertion here read `expect(REQUIRED_DELIVERY_MODULES)
    // .toContain('channel/delivery.ts')` — the constant asserted to contain what
    // the constant declared. A comparison with itself can never disagree, so it
    // could not detect the thing it existed to detect: a stale list.
    //
    // The population is now DERIVED, so this checks a real property instead — the
    // contract module plus everything that imports it.
    const modules = await resolveRequiredDeliveryModules(SUBJECT_SRC_ROOT, lexModule);

    expect(modules, 'the module declaring the contract is always on the path').toContain(
      DELIVERY_CONTRACT_MODULE,
    );

    // The derivation is strictly WIDER than the list it replaced: this importer
    // was on a required delivery path the whole time and was never scanned.
    expect(
      modules,
      'events/composite.ts calls `deliver` and the transcribed list missed it',
    ).toContain('events/composite.ts');
    expect(modules).toContain('adapters/channel/emitter.ts');

    // …and narrower than "everything under channel/": the discriminant is the
    // import edge, so channel modules that carry no delivery contract stay out.
    expect(modules).not.toContain('events/channel/priority.ts');
    expect(modules).not.toContain('adapters/channel/formatter.ts');

    // Every derived module is a module the audit actually reads.
    const result = await auditDeliverySafety(SUBJECT_SRC_ROOT, lexModule);
    expect([...result.modules].sort()).toEqual([...modules].sort());
  });

  it('DeliveryPopulation_TracksANewImporterWithoutAnEdit', async () => {
    // The whole point of deriving: a module that starts delivering is covered the
    // day it lands, not the day someone remembers to widen an array. Proven on a
    // synthetic tree so the claim does not depend on the live tree's shape.
    const root = await mkdtemp(join(tmpdir(), 'exarchos-delivery-pop-'));
    try {
      await mkdir(join(root, 'events', 'channel'), { recursive: true });
      await mkdir(join(root, 'newcomer'), { recursive: true });
      await writeFile(join(root, DELIVERY_CONTRACT_MODULE), 'export const deliver = () => {};\n');
      await writeFile(join(root, 'newcomer/pusher.ts'), '');
      expect(await resolveRequiredDeliveryModules(root, lexModule)).toEqual([DELIVERY_CONTRACT_MODULE]);

      // The newcomer starts importing the contract — no edit to any list.
      await writeFile(
        join(root, 'newcomer/pusher.ts'),
        `import { deliver } from '../events/channel/delivery.js';\nexport const push = () => deliver();\n`,
      );
      expect(await resolveRequiredDeliveryModules(root, lexModule)).toEqual([
        DELIVERY_CONTRACT_MODULE,
        'newcomer/pusher.ts',
      ]);

      // …and it is judged, not merely listed: a swallow planted in the newcomer
      // fails the audit.
      await writeFile(
        join(root, 'newcomer/pusher.ts'),
        `import { deliver } from '../events/channel/delivery.js';\n` +
          `export const push = async () => { try { await deliver(); } catch {} };\n`,
      );
      const result = await auditDeliverySafety(root, lexModule);
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.module)).toContain('newcomer/pusher.ts');
      expect(result.diagnostics.map((d) => d.code)).toContain('SILENT_SWALLOW');
    } finally {
      await rmrfAsync(root);
    }
  });

  it('DeliveryPopulation_ImportInACommentDoesNotEnlistAModule', async () => {
    // The discriminant is an import EDGE, not the spelling of a path. A module
    // that merely mentions the contract in prose is not on the delivery path,
    // and enlisting it would make the population grow by documentation.
    const root = await mkdtemp(join(tmpdir(), 'exarchos-delivery-cmt-'));
    try {
      await mkdir(join(root, 'events', 'channel'), { recursive: true });
      await writeFile(join(root, DELIVERY_CONTRACT_MODULE), 'export const deliver = () => {};\n');
      await writeFile(
        join(root, 'bystander.ts'),
        `// import { deliver } from './events/channel/delivery.js';\nexport const x = 1;\n`,
      );
      expect(await resolveRequiredDeliveryModules(root, lexModule)).toEqual([DELIVERY_CONTRACT_MODULE]);
    } finally {
      await rmrfAsync(root);
    }
  });

  it('DeliverySafety_EmptyPopulation_FailsRatherThanReportingACleanPath', async () => {
    // NON-EMPTY DENOMINATOR. An empty module list used to produce `ok: true`
    // with zero findings — the same verdict a clean delivery path produces.
    // "Nothing to check" and "checked, nothing wrong" must not be the same
    // answer.
    const result = await auditDeliverySafety(SUBJECT_SRC_ROOT, lexModule, []);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['EMPTY_POPULATION']);
  });

  it('DeliverySafety_ContractModuleMoved_FailsClosed', async () => {
    // The same tooth reached through the DERIVATION rather than by passing `[]`:
    // if the contract module is not where it is declared to be, the population
    // collapses and the sweep must fail instead of reporting a clean path.
    const root = await mkdtemp(join(tmpdir(), 'exarchos-delivery-gone-'));
    try {
      await writeFile(join(root, 'unrelated.ts'), 'export const x = 1;\n');
      // No explicit population: this must reach EMPTY_POPULATION through
      // `resolveRequiredDeliveryModules` itself. Passing `[]` here only restated
      // the test above it and left the derivation path unexercised — which is
      // how an unconditional seed made the empty case unreachable in production
      // while both tests stayed green.
      const result = await auditDeliverySafety(root, lexModule);
      expect(result.ok).toBe(false);
      expect(result.diagnostics[0]?.code).toBe('EMPTY_POPULATION');
      expect(result.diagnostics[0]?.message).toContain(DELIVERY_CONTRACT_MODULE);
      // …and it is a DIAGNOSTIC, not an ENOENT escaping from `readFile`.
      expect(result.modules).toEqual([]);
    } finally {
      await rmrfAsync(root);
    }
  });

  it('FAILS when a required module is replaced by one that silently swallows', async () => {
    // Point the audit at a fixture module planted with a silent swallow.
    const result = await auditDeliverySafety(FIXTURE_ROOT, lexModule, ['swallows.fixture.ts']);
    expect(result.ok).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]?.finding.kind).toBe('empty-catch');
  });
});
