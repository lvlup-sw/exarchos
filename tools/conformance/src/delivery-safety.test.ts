// The import graph derives the delivery population: the contract module plus each module with a
// one-hop import edge to it. These tests check the audit verdict over that population. The two
// stay independent: the graph does not know what the audit requires, and the audit does not
// pick its own subjects.
// @oracle-sources: ./delivery-safety.ts, the one-hop import graph resolved from source

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
  /** The verdict must range over a real population, not an empty one. */
  it('the real required-delivery modules contain zero silent swallows', async () => {
    const result = await auditDeliverySafety(SUBJECT_SRC_ROOT, lexModule);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.modules.length).toBeGreaterThan(0);
  });

  /**
   * The population is the contract module plus each module that imports it. It includes
   * `events/composite.ts`. It excludes a channel module with no import edge to the contract.
   * The audit reads exactly the derived modules.
   */
  it('DeliveryPopulation_IsDerivedFromTheImportGraph_NotTranscribed', async () => {
    const modules = await resolveRequiredDeliveryModules(SUBJECT_SRC_ROOT, lexModule);

    expect(modules, 'the module declaring the contract is always on the path').toContain(
      DELIVERY_CONTRACT_MODULE,
    );

    expect(
      modules,
      'events/composite.ts calls `deliver` and the transcribed list missed it',
    ).toContain('events/composite.ts');
    expect(modules).toContain('adapters/channel/emitter.ts');

    expect(modules).not.toContain('events/channel/priority.ts');
    expect(modules).not.toContain('adapters/channel/formatter.ts');

    const result = await auditDeliverySafety(SUBJECT_SRC_ROOT, lexModule);
    expect([...result.modules].sort()).toEqual([...modules].sort());
  });

  /**
   * A module that starts to import the contract joins the population with no list edit, and a
   * swallow in it fails the audit. A synthetic tree keeps the proof free of the live tree shape.
   */
  it('DeliveryPopulation_TracksANewImporterWithoutAnEdit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'exarchos-delivery-pop-'));
    try {
      await mkdir(join(root, 'events', 'channel'), { recursive: true });
      await mkdir(join(root, 'newcomer'), { recursive: true });
      await writeFile(join(root, DELIVERY_CONTRACT_MODULE), 'export const deliver = () => {};\n');
      await writeFile(join(root, 'newcomer/pusher.ts'), '');
      expect(await resolveRequiredDeliveryModules(root, lexModule)).toEqual([DELIVERY_CONTRACT_MODULE]);

      await writeFile(
        join(root, 'newcomer/pusher.ts'),
        `import { deliver } from '../events/channel/delivery.js';\nexport const push = () => deliver();\n`,
      );
      expect(await resolveRequiredDeliveryModules(root, lexModule)).toEqual([
        DELIVERY_CONTRACT_MODULE,
        'newcomer/pusher.ts',
      ]);

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

  /**
   * The discriminant is an import edge, not the spelling of a path. A module that only names the
   * contract in a comment is not on the delivery path.
   */
  it('DeliveryPopulation_ImportInACommentDoesNotEnlistAModule', async () => {
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

  /** "Nothing to check" and "checked, nothing wrong" must not give the same answer. */
  it('DeliverySafety_EmptyPopulation_FailsRatherThanReportingACleanPath', async () => {
    const result = await auditDeliverySafety(SUBJECT_SRC_ROOT, lexModule, []);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['EMPTY_POPULATION']);
  });

  /**
   * The empty-population failure, reached through the derivation and not through an explicit `[]`.
   * If the contract module is absent, the sweep must return the `EMPTY_POPULATION` diagnostic, not
   * an `ENOENT` throw from `readFile`.
   */
  it('DeliverySafety_ContractModuleMoved_FailsClosed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'exarchos-delivery-gone-'));
    try {
      await writeFile(join(root, 'unrelated.ts'), 'export const x = 1;\n');
      const result = await auditDeliverySafety(root, lexModule);
      expect(result.ok).toBe(false);
      expect(result.diagnostics[0]?.code).toBe('EMPTY_POPULATION');
      expect(result.diagnostics[0]?.message).toContain(DELIVERY_CONTRACT_MODULE);
      expect(result.modules).toEqual([]);
    } finally {
      await rmrfAsync(root);
    }
  });

  it('FAILS when a required module is replaced by one that silently swallows', async () => {
    const result = await auditDeliverySafety(FIXTURE_ROOT, lexModule, ['swallows.fixture.ts']);
    expect(result.ok).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]?.finding.kind).toBe('empty-catch');
  });
});
