// ─── The structural refactor's terminal gate ─────────────────────────────────
//
// A phase is finished when the checks that govern it all run and all pass, on
// every platform that ships. The failure this guards against is not a red gate
// — it is a gate that stopped being invoked, which looks like success from
// every angle except the one that counts.
//
// Three claims are checkable here and are checked. Whether the whole suite is
// green on a clean clone is CI's job and cannot be asserted from inside a
// working tree; what CAN be asserted is that CI still declares the jobs that
// would find out.
//
// @oracle-sources: ../../.github/workflows/ci.yml, ../../package.json, ../../tools/audit/registered-actions-snapshot.json

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ciYaml = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

describe('Phase2_CleanClone_AllGatesGreenOnLinuxAndWindows', () => {
  it('CI still runs on BOTH platforms', () => {
    // Windows is where this repository's portability defects surface —
    // path separators, file-URL comparison, concurrent-rename EPERM. A matrix
    // that quietly loses the Windows leg would take the whole class with it.
    expect(ciYaml, 'CI declares no Linux runner').toMatch(/runs-on:\s*ubuntu-latest/);
    expect(ciYaml, 'CI declares no Windows runner').toMatch(/runs-on:\s*windows-latest/);
  });

  it('every gate the phase depends on is a real npm script', () => {
    // The structural work added and retargeted gates. Each has to be
    // INVOCABLE, because a gate that exists as a file and not as a script is
    // reachable only by someone who already knows it is there.
    const scripts = new Set(Object.keys(pkg.scripts ?? {}));
    const required = [
      'typecheck',
      'lint',
      'quality-check',
      'render:guard',
      'runtimes:guard',
      'build:skills',
    ];
    const absent = required.filter((s) => !scripts.has(s));
    expect(absent, `gates declared by the phase but absent from package.json: ${absent.join(', ')}`).toEqual([]);
  });

  it('the aggregator gate is what a branch rule can require', () => {
    // Branch protection is repo settings and not assertable from here, so the
    // aggregator job stands in for it: if `ci-gate` stops existing, there is
    // nothing left for a required check to point at.
    expect(ciYaml).toMatch(/^\s{2}ci-gate:/m);
  });
});

describe('Phase2_PersistedIdentifiers_MatchTheTask047Snapshot', () => {
  it('the recorded action snapshot still exists and is populated', () => {
    // The decomposition wave's acceptance oracle. `identifier-stability.test.ts`
    // does the comparison; this asserts the ARTIFACT it compares against is
    // present and non-trivial, because a comparison against an empty snapshot
    // passes for every input.
    const snapshotPath = path.join(REPO_ROOT, 'tools/audit/registered-actions-snapshot.json');
    expect(fs.existsSync(snapshotPath), 'the registered-actions snapshot is missing').toBe(true);

    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as {
      counts?: { tools?: number; visibleTools?: number; actions?: number; eventTypes?: number };
      tools?: unknown[];
    };
    expect(snapshot.counts?.tools ?? 0, 'snapshot records no tools').toBeGreaterThanOrEqual(5);
    expect(snapshot.counts?.actions ?? 0, 'snapshot records no actions').toBeGreaterThan(100);
    expect(snapshot.counts?.eventTypes ?? 0, 'snapshot records no event types').toBeGreaterThan(100);

    // The counts are a summary; the per-tool rows are what the comparison
    // walks. A snapshot carrying counts and no rows would satisfy the three
    // assertions above and compare against nothing.
    expect(snapshot.tools?.length ?? 0, 'snapshot carries counts but no tool rows').toBe(
      snapshot.counts?.tools ?? -1,
    );
  });

  it('the comparison that uses it is still collected', () => {
    // A snapshot nothing reads is a file, not a guard.
    expect(
      fs.existsSync(path.join(REPO_ROOT, 'tests/architecture/identifier-stability.test.ts')),
      'the identifier-stability comparison is gone — the snapshot governs nothing',
    ).toBe(true);
  });
});
