import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  findSilentSwallows,
  maskLiteralsAndComments,
  auditDeliverySafety,
  REQUIRED_DELIVERY_MODULES,
} from './delivery-safety.js';
import { SUBJECT_SRC_ROOT } from './subject-root.js';

/** The census's own fixtures, which moved into this package with it. */
const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

describe('findSilentSwallows — detection', () => {
  it('flags a bare empty catch block', () => {
    const findings = findSilentSwallows(`
      async function push() {
        try { await send(); } catch {}
      }
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('empty-catch');
  });

  it('flags an empty catch with a bound binding', () => {
    const findings = findSilentSwallows(`try { x(); } catch (e) {\n  // ignore\n}`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('empty-catch');
  });

  it('flags empty .catch() handler forms', () => {
    const findings = findSilentSwallows(`
      send().catch(() => {});
      send().catch((e) => {});
      send().catch(e => {});
      send().catch(async () => {});
      send().catch(() => undefined);
    `);
    expect(findings.filter((f) => f.kind === 'empty-catch-handler')).toHaveLength(5);
  });
});

describe('findSilentSwallows — no false positives', () => {
  it('does NOT flag a catch that handles the error', () => {
    const findings = findSilentSwallows(`
      try { await send(); } catch (e) { return failed(e); }
      other().catch((e) => log(e));
    `);
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag "catch {}" inside a comment or string', () => {
    const findings = findSilentSwallows(`
      // never write catch {}
      /* an empty catch {} is banned */
      const doc = "avoid catch {} here";
      const tmpl = \`also catch {} in a template\`;
      try { work(); } catch (e) { handle(e); }
    `);
    expect(findings).toHaveLength(0);
  });
});

describe('maskLiteralsAndComments', () => {
  it('preserves length and newlines while blanking literal/comment content', () => {
    const src = `a // comment\n"string"`;
    const masked = maskLiteralsAndComments(src);
    expect(masked.length).toBe(src.length);
    expect(masked.split('\n')).toHaveLength(2);
    expect(masked).not.toContain('comment');
    expect(masked).not.toContain('string');
    expect(masked.startsWith('a ')).toBe(true);
  });
});

describe('auditDeliverySafety — live required-delivery modules', () => {
  it('the real required-delivery modules contain zero silent swallows', async () => {
    const result = await auditDeliverySafety(SUBJECT_SRC_ROOT);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('scans exactly the declared required-delivery modules', () => {
    expect(REQUIRED_DELIVERY_MODULES).toContain('channel/delivery.ts');
    expect(REQUIRED_DELIVERY_MODULES).toContain('channel/emitter.ts');
  });

  it('FAILS when a required module is replaced by one that silently swallows', async () => {
    // Point the audit at a fixture module planted with a silent swallow.
    const result = await auditDeliverySafety(FIXTURE_ROOT, ['swallows.fixture.ts']);
    expect(result.ok).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]?.finding.kind).toBe('empty-catch');
  });
});
