import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  enumeratePairs,
  resolvePair,
  classifyPair,
  computeEmit,
  applyEmit,
  verifyCases,
  normalizedCases,
  normalizedPreamble,
  rewriteRelativeImports,
  run,
  DEFAULT_SRC_ROOT,
  EXPECTED_PAIR_COUNT,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_FINDING,
} from '../../../tools/audit/consolidate-suite.mjs';

// The tool resolves relative import specifiers against a file's ABSOLUTE
// directory, so pure tests use synthetic dirs that mirror the real layout
// (`.../src/__tests__/<area>` for legacy, `.../src/<area>` for co-located).
// Two specifiers that point at the same target module then normalize equal.
const LEGACY_DIR = '/repo/src/__tests__/workflow';
const CANON_DIR = '/repo/src/workflow';

// ─── AST case extraction ─────────────────────────────────────────────────────

describe('normalizedCases (case extraction via TS AST)', () => {
  it('counts every it/test variant (.skip/.only/.todo/.each) once, and no hooks/describes', () => {
    const src = `
      import { describe, it, test, expect, beforeEach } from 'vitest';
      beforeEach(() => {});
      describe('suite', () => {
        it('a', () => { expect(1).toBe(1); });
        it.skip('b', () => {});
        test.only('c', () => {});
        it.todo('d');
        it.each([[1], [2]])('e %i', (n) => { expect(n).toBeGreaterThan(0); });
      });
    `;
    // 5 cases: a, b, c, d, e — NOT beforeEach, NOT describe.
    expect(normalizedCases(src, CANON_DIR)).toHaveLength(5);
  });

  it('normalizes a relative import inside a case body (modulo import path)', () => {
    const legacy = `it('x', async () => { const m = await import('../../workflow/foo.js'); expect(m).toBeDefined(); });`;
    const canon = `it('x', async () => { const m = await import('./foo.js'); expect(m).toBeDefined(); });`;
    // Same target module from each dir → identical normalized text.
    expect(normalizedCases(legacy, LEGACY_DIR)[0]).toBe(normalizedCases(canon, CANON_DIR)[0]);
  });
});

// ─── classifyPair: merge vs relocate ─────────────────────────────────────────

describe('classifyPair', () => {
  const canonPreambleIdentical = `
    import { describe, it, expect } from 'vitest';
    import { foo } from './foo.js';
    describe('foo', () => {
      it('works', () => { expect(foo()).toBe(1); });
    });
  `;
  const legacyPreambleIdentical = `
    import { describe, it, expect } from 'vitest';
    import { foo } from '../../workflow/foo.js';
    describe('foo', () => {
      it('works', () => { expect(foo()).toBe(1); });
    });
  `;

  it('preamble-identical modulo import paths → merge', () => {
    expect(
      classifyPair(
        { text: legacyPreambleIdentical, absDir: LEGACY_DIR },
        { text: canonPreambleIdentical, absDir: CANON_DIR },
      ),
    ).toBe('merge');
  });

  it('import-path-only diff → merge (paths are the sanctioned modulo)', () => {
    // Same as above but proven at the preamble layer directly.
    expect(normalizedPreamble(legacyPreambleIdentical, LEGACY_DIR)).toBe(
      normalizedPreamble(canonPreambleIdentical, CANON_DIR),
    );
  });

  it('preamble-divergent (extra module-scope import) → relocate', () => {
    const legacyExtra = `
      import { describe, it, expect } from 'vitest';
      import { foo } from '../../workflow/foo.js';
      import { extra } from '../../workflow/extra.js';
      describe('foo', () => { it('works', () => { expect(foo()).toBe(1); }); });
    `;
    expect(
      classifyPair(
        { text: legacyExtra, absDir: LEGACY_DIR },
        { text: canonPreambleIdentical, absDir: CANON_DIR },
      ),
    ).toBe('relocate');
  });

  it('vi.mock factory divergent → relocate (mocks are file-scoped, non-composable)', () => {
    const base = (factory: string) => `
      import { describe, it, expect, vi } from 'vitest';
      vi.mock('./dep.js', () => (${factory}));
      describe('s', () => { it('t', () => { expect(1).toBe(1); }); });
    `;
    const legacy = base('{ dep: () => 1 }').replace('./dep.js', '../../workflow/dep.js');
    const canon = base('{ dep: () => 2 }');
    expect(
      classifyPair({ text: legacy, absDir: LEGACY_DIR }, { text: canon, absDir: CANON_DIR }),
    ).toBe('relocate');
  });

  it('vi.hoisted state divergent → relocate', () => {
    const legacy = `
      import { describe, it, expect, vi } from 'vitest';
      const state = vi.hoisted(() => ({ seed: 1 }));
      describe('s', () => { it('t', () => { expect(state.seed).toBe(1); }); });
    `;
    const canon = `
      import { describe, it, expect, vi } from 'vitest';
      const state = vi.hoisted(() => ({ seed: 2 }));
      describe('s', () => { it('t', () => { expect(state.seed).toBe(1); }); });
    `;
    expect(
      classifyPair({ text: legacy, absDir: LEGACY_DIR }, { text: canon, absDir: CANON_DIR }),
    ).toBe('relocate');
  });

  it('divergent top-describe-scope hook → relocate', () => {
    const canon = `
      import { describe, it, expect } from 'vitest';
      describe('s', () => {
        beforeEach(() => { globalThis.x = 1; });
        it('t', () => { expect(1).toBe(1); });
      });
    `;
    const legacy = `
      import { describe, it, expect } from 'vitest';
      describe('s', () => {
        beforeEach(() => { globalThis.x = 999; });
        it('t', () => { expect(1).toBe(1); });
      });
    `;
    expect(
      classifyPair({ text: legacy, absDir: LEGACY_DIR }, { text: canon, absDir: CANON_DIR }),
    ).toBe('relocate');
  });
});

// ─── enumeratePairs (directory intersection, temp tree) ──────────────────────

describe('enumeratePairs', () => {
  let root: string;
  let srcRoot: string;

  const writeFile = (rel: string, content: string) => {
    const full = path.join(srcRoot, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'consolidate-enum-'));
    srcRoot = path.join(root, 'src');
    mkdirSync(srcRoot, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports a pair only when BOTH legacy and co-located copies exist', () => {
    writeFile('__tests__/workflow/both.test.ts', 'it("x", () => {});');
    writeFile('workflow/both.test.ts', 'it("x", () => {});');
    writeFile('__tests__/workflow/legacy-only.test.ts', 'it("x", () => {});'); // no co-located mirror
    writeFile('views/colocated-only.test.ts', 'it("x", () => {});'); // no legacy mirror

    const pairs = enumeratePairs(srcRoot);
    expect(pairs.map((p) => p.id)).toEqual(['workflow/both']);
  });

  it('keys strictly on (area, basename): workflow/schemas and event-store/schemas are DISTINCT pairs', () => {
    for (const area of ['workflow', 'event-store']) {
      writeFile(`__tests__/${area}/schemas.test.ts`, 'it("x", () => {});');
      writeFile(`${area}/schemas.test.ts`, 'it("x", () => {});');
      writeFile(`__tests__/${area}/tools.test.ts`, 'it("x", () => {});');
      writeFile(`${area}/tools.test.ts`, 'it("x", () => {});');
    }
    const ids = enumeratePairs(srcRoot).map((p) => p.id);
    expect(ids).toEqual([
      'event-store/schemas',
      'event-store/tools',
      'workflow/schemas',
      'workflow/tools',
    ]);
  });

  it('ignores a bare __tests__/<base>.test.ts with no area subdir', () => {
    writeFile('__tests__/top-level.test.ts', 'it("x", () => {});');
    writeFile('top-level.test.ts', 'it("x", () => {});');
    expect(enumeratePairs(srcRoot)).toHaveLength(0);
  });
});

// ─── computeEmit / applyEmit ─────────────────────────────────────────────────

describe('computeEmit', () => {
  let root: string;
  let srcRoot: string;

  const writeFile = (rel: string, content: string) => {
    const full = path.join(srcRoot, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'consolidate-emit-'));
    srcRoot = path.join(root, 'src');
    mkdirSync(srcRoot, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('merge: dedups a textually-identical case and appends the distinct one; deletes legacy', () => {
    const canon = `import { describe, it, expect } from 'vitest';
import { sample } from './sample.js';
describe('sample', () => {
  it('shared_case', () => { expect(sample()).toBe(1); });
  it('canonical_only', () => { expect(sample()).toBe(2); });
});
`;
    const legacy = `import { describe, it, expect } from 'vitest';
import { sample } from '../../workflow/sample.js';
describe('sample', () => {
  it('shared_case', () => { expect(sample()).toBe(1); });
  it('legacy_only', () => { expect(sample()).toBe(3); });
});
`;
    writeFile('workflow/sample.test.ts', canon);
    writeFile('__tests__/workflow/sample.test.ts', legacy);

    const pair = resolvePair(srcRoot, 'workflow/sample');
    const plan = computeEmit(pair);

    expect(plan.mode).toBe('merge');
    expect(plan.droppedDuplicates).toBe(1); // shared_case is a textual duplicate
    expect(plan.appendedCases).toBe(1); // legacy_only carried over
    expect(plan.deletes).toEqual([pair.legacyPath]);

    const [mergedWrite] = plan.writes;
    if (!mergedWrite) throw new Error('a merge plan must emit a write');
    const merged = mergedWrite.content;
    expect(merged).toContain('legacy_only');
    expect(merged).toContain('canonical_only');
    // The merged file has exactly 3 distinct cases (shared appears once).
    expect(normalizedCases(merged, pair.canonicalDir)).toHaveLength(3);

    applyEmit(plan);
    expect(existsSync(pair.legacyPath)).toBe(false);
    expect(readFileSync(pair.canonicalPath, 'utf8')).toContain('legacy_only');
  });

  it('relocate: writes <base>.legacy.test.ts with rewritten imports and deletes legacy', () => {
    const canon = `import { describe, it, expect } from 'vitest';
import { sample } from './sample.js';
describe('sample', () => { it('c', () => { expect(sample()).toBe(1); }); });
`;
    // Divergent preamble (extra vi.mock) → relocate.
    const legacy = `import { describe, it, expect, vi } from 'vitest';
import { sample } from '../../workflow/sample.js';
vi.mock('../../workflow/sample.js', () => ({ sample: () => 9 }));
describe('sample', () => { it('l', () => { expect(sample()).toBe(9); }); });
`;
    writeFile('workflow/sample.test.ts', canon);
    writeFile('__tests__/workflow/sample.test.ts', legacy);

    const pair = resolvePair(srcRoot, 'workflow/sample');
    const plan = computeEmit(pair);

    expect(plan.mode).toBe('relocate');
    const [relocated] = plan.writes;
    if (!relocated) throw new Error('a relocate plan must emit a write');
    const dest = relocated.path;
    expect(path.basename(dest)).toBe('sample.legacy.test.ts');
    expect(path.dirname(dest)).toBe(pair.canonicalDir);

    const content = relocated.content;
    expect(content).toContain("from './sample.js'"); // rewritten from ../../workflow/
    expect(content).not.toContain('../../workflow/sample.js');
    expect(content).toContain("vi.mock('./sample.js'"); // mock path rewritten too
    expect(plan.deletes).toEqual([pair.legacyPath]);

    applyEmit(plan);
    expect(existsSync(pair.legacyPath)).toBe(false);
    expect(existsSync(dest)).toBe(true);
    // The canonical file is untouched by a relocate.
    expect(readFileSync(pair.canonicalPath, 'utf8')).toBe(canon);
  });
});

// ─── verifyCases (the Task-004 gate check) ───────────────────────────────────

describe('verifyCases', () => {
  const legacyPre = {
    text: `import { describe, it, expect } from 'vitest';
import { sample } from '../../workflow/sample.js';
describe('sample', () => {
  it('shared_case', () => { expect(sample()).toBe(1); });
  it('legacy_only', () => { expect(sample()).toBe(3); });
});
`,
    absDir: LEGACY_DIR,
  };
  const canonicalPre = {
    text: `import { describe, it, expect } from 'vitest';
import { sample } from './sample.js';
describe('sample', () => {
  it('shared_case', () => { expect(sample()).toBe(1); });
  it('canonical_only', () => { expect(sample()).toBe(2); });
});
`,
    absDir: CANON_DIR,
  };

  it('merge result preserving every pre-image case → ok', () => {
    const merged = {
      text: `import { describe, it, expect } from 'vitest';
import { sample } from './sample.js';
describe('sample', () => {
  it('shared_case', () => { expect(sample()).toBe(1); });
  it('canonical_only', () => { expect(sample()).toBe(2); });
  it('legacy_only', () => { expect(sample()).toBe(3); });
});
`,
      absDir: CANON_DIR,
    };
    const report = verifyCases(legacyPre, canonicalPre, [merged]);
    expect(report.ok).toBe(true);
    expect(report.lost).toHaveLength(0);
    expect(report.preamblesIdentical).toBe(true);
  });

  it('a pre-image case ABSENT from the result → not ok (lost/unproven)', () => {
    // Result silently drops legacy_only and it has NO surviving twin.
    const broken = {
      text: `import { describe, it, expect } from 'vitest';
import { sample } from './sample.js';
describe('sample', () => {
  it('shared_case', () => { expect(sample()).toBe(1); });
  it('canonical_only', () => { expect(sample()).toBe(2); });
});
`,
      absDir: CANON_DIR,
    };
    const report = verifyCases(legacyPre, canonicalPre, [broken]);
    expect(report.ok).toBe(false);
    expect(report.lost.map((l) => l.side)).toContain('legacy');
    expect(report.lost.some((l) => l.text.includes('legacy_only'))).toBe(true);
  });

  it('relocate result (canonical + rewritten sibling) preserves both sides → ok', () => {
    const relocated = {
      // legacy content with imports rewritten to the co-located dir.
      text: rewriteRelativeImports(legacyPre.text, LEGACY_DIR, CANON_DIR),
      absDir: CANON_DIR,
    };
    const report = verifyCases(legacyPre, canonicalPre, [
      { text: canonicalPre.text, absDir: CANON_DIR },
      relocated,
    ]);
    expect(report.ok).toBe(true);
    expect(report.lost).toHaveLength(0);
  });

  it('a case surviving only via import-path rewrite still counts as preserved', () => {
    const legacyDyn = {
      text: `import { describe, it, expect } from 'vitest';
describe('s', () => {
  it('dyn', async () => { const m = await import('../../workflow/sample.js'); expect(m).toBeDefined(); });
});
`,
      absDir: LEGACY_DIR,
    };
    const canonEmpty = {
      text: `import { describe, it, expect } from 'vitest';
describe('s', () => {});
`,
      absDir: CANON_DIR,
    };
    const relocated = {
      text: `import { describe, it, expect } from 'vitest';
describe('s', () => {
  it('dyn', async () => { const m = await import('./sample.js'); expect(m).toBeDefined(); });
});
`,
      absDir: CANON_DIR,
    };
    const report = verifyCases(legacyDyn, canonEmpty, [canonEmpty, relocated]);
    expect(report.ok).toBe(true);
  });
});

// ─── CLI dispatch (run) ──────────────────────────────────────────────────────

describe('run (CLI dispatch)', () => {
  let root: string;
  let srcRoot: string;
  let out: string[];
  let err: string[];
  const opts = () => ({ srcRoot, log: (m: string) => out.push(m), errlog: (m: string) => err.push(m) });

  const writeFile = (rel: string, content: string) => {
    const full = path.join(srcRoot, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'consolidate-cli-'));
    srcRoot = path.join(root, 'src');
    mkdirSync(srcRoot, { recursive: true });
    out = [];
    err = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('--enumerate prints one id per pair and a count footer', () => {
    writeFile('__tests__/workflow/a.test.ts', 'it("x", () => {});');
    writeFile('workflow/a.test.ts', 'it("x", () => {});');
    const code = run(['--enumerate'], opts());
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('workflow/a');
    expect(out).toContain('# 1 pair');
  });

  it('--plan on a missing pair fails with a usage exit code', () => {
    const code = run(['--plan', 'workflow/nope'], opts());
    expect(code).toBe(EXIT_USAGE);
    expect(err.join('\n')).toMatch(/both files must exist/);
  });

  it('--help exits OK', () => {
    expect(run(['--help'], opts())).toBe(EXIT_OK);
  });
});

// ─── integration against the LIVE tree (HIGH tier) ───────────────────────────

// The wave-3b campaign (#1705) de-diverged all 17 duplicate-location pairs, so the
// live tree now enumerates ZERO remaining pairs. This block is the completion /
// regression guard; per-mode tool behavior (merge/relocate classification, emit,
// verify) is covered by the fixture describes above.
describe('integration (live tree)', () => {
  it('enumerates no remaining duplicate-location pairs (all 17 consolidated)', () => {
    expect(enumeratePairs(DEFAULT_SRC_ROOT)).toHaveLength(EXPECTED_PAIR_COUNT);
  });

  it('--enumerate on the live tree reports zero remaining pairs via the CLI', () => {
    const out: string[] = [];
    const code = run(['--enumerate'], { log: (m) => out.push(m) });
    expect(code).toBe(EXIT_OK);
    expect(out).toContain(`# ${EXPECTED_PAIR_COUNT} pairs`);
  });
});
