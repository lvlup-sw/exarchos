// The terminal gate of the structural refactor.
//
// A phase is complete when each check that governs it runs and passes, on each
// platform that ships. This suite guards against a gate that nothing invokes.
// Such a gate looks the same as a gate that passes.
//
// The suite checks wiring only. CI declares Linux and Windows. The npm scripts
// of the phase exist. The workflow that feeds `ci-gate` invokes those scripts.
// The identifier snapshot is not empty.
//
// CI proves that the suite passes on a clean clone.
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

/** True when `cmd` is a workflow `run:` value, not a comment that mentions it. */
function isWorkflowRunStep(workflow: string, cmd: string): boolean {
  const escaped = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s+-?\\s*run:\\s+${escaped}\\s*$`, 'm').test(workflow);
}

describe('Phase2_CiStillDeclaresTheJobsThatWouldFindOut', () => {
  /**
   * The portability defects of this repository show on Windows: path separators,
   * file-URL comparison, and EPERM on a concurrent rename. A matrix that loses
   * the Windows runner loses that whole class.
   */
  it('CI still runs on BOTH platforms', () => {
    expect(ciYaml, 'CI declares no Linux runner').toMatch(/runs-on:\s*ubuntu-latest/);
    expect(ciYaml, 'CI declares no Windows runner').toMatch(/runs-on:\s*windows-latest/);
  });

  /**
   * Each gate must be an npm script. When a gate is a file and not a script,
   * only a person who knows about the file can run it.
   */
  it('every gate the phase depends on is a real npm script', () => {
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

  /**
   * Branch protection is a repository setting that a test cannot read. The
   * `ci-gate` aggregator job stands in for it, because a required check needs a
   * job to name.
   */
  it('the aggregator gate is what a branch rule can require', () => {
    expect(ciYaml).toMatch(/^\s{2}ci-gate:/m);
  });

  /**
   * A script that exists is not a script that CI runs. The `core` vitest project
   * collects the layer census (`auditLayerBoundaries`). Linux runs that project
   * as `test:coverage`, Windows runs it as `test:core`, and `test:run` never
   * collects it. Both names are required, because a substring check on one name
   * stays green when the other platform stops. Knip runs in the
   * `validate-no-legacy` rollup and has no npm script name. `quality-check` is
   * not a CI job: `lint:invariants` and `render:guard` run its two parts.
   */
  it('CI still invokes the gates the phase depends on before ci-gate', () => {
    const requiredInvocations = [
      'npm run typecheck',
      'npm run test:run',
      'npm run test:conformance',
      'npm run render:guard',
      'npm run lint:invariants',
      'npm run test:coverage',
      'npm run test:core',
    ];
    const absent = requiredInvocations.filter((cmd) => !isWorkflowRunStep(ciYaml, cmd));
    expect(absent, `CI no longer invokes as a run step: ${absent.join(', ')}`).toEqual([]);

    expect(ciYaml, 'CI dropped the knip host').toMatch(/knip-diff|validate-no-legacy/);
    expect(ciYaml, 'CI dropped the shared ESLint host').toMatch(/npm run lint:comments/);
  });

  /**
   * `includes('npm run test:core')` stays green when the only mention is a
   * comment. The run-step matcher must reject that case.
   */
  it('a comment that names a required script is not an invocation', () => {
    const commented = ciYaml.replace(
      /^(\s+-?\s*)run:\s+npm run test:coverage\s*$/m,
      '$1# run: npm run test:coverage',
    );
    const stillAStep = isWorkflowRunStep(commented, 'npm run test:coverage');
    expect(stillAStep, 'commenting out the Linux census host still counted as a run step').toBe(
      false,
    );
  });
});

describe('Phase2_PersistedIdentifiers_MatchTheTask047Snapshot', () => {
  /**
   * `identifier-stability.test.ts` makes the comparison. This test asserts that
   * the snapshot exists and holds tools, actions and event types. The comparison
   * reads the row of each tool and not the counts, so the number of rows must
   * equal the tool count.
   */
  it('the recorded action snapshot still exists and is populated', () => {
    const snapshotPath = path.join(REPO_ROOT, 'tools/audit/registered-actions-snapshot.json');
    expect(fs.existsSync(snapshotPath), 'the registered-actions snapshot is missing').toBe(true);

    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as {
      counts?: { tools?: number; visibleTools?: number; actions?: number; eventTypes?: number };
      tools?: unknown[];
    };
    expect(snapshot.counts?.tools ?? 0, 'snapshot records no tools').toBeGreaterThanOrEqual(5);
    expect(snapshot.counts?.actions ?? 0, 'snapshot records no actions').toBeGreaterThan(100);
    expect(snapshot.counts?.eventTypes ?? 0, 'snapshot records no event types').toBeGreaterThan(100);

    expect(snapshot.tools?.length ?? 0, 'snapshot carries counts but no tool rows').toBe(
      snapshot.counts?.tools ?? -1,
    );
  });

  /** A snapshot that nothing reads guards nothing. This test checks only that the comparison file exists. */
  it('the comparison that uses it is still collected', () => {
    expect(
      fs.existsSync(path.join(REPO_ROOT, 'tests/architecture/identifier-stability.test.ts')),
      'the identifier-stability comparison is gone — the snapshot governs nothing',
    ).toBe(true);
  });
});
