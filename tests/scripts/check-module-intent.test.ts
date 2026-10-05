/**
 * Tests for the module-intent CI gate, `tools/audit/gates/check-module-intent.mjs`.
 * The gate fails a production module under `src` that has zero production importers and declares no intent.
 * Intent is a valid `RESERVED(issue, owner, expires)` header, or membership in an allowlist class.
 * Reachability comes from `tools/audit/refgraph.mjs` and two sweeps: cross-root importers and npm-script entrypoints.
 * Exit codes: 0 clean, 1 violation, 2 fail closed (a scan crash, an unreadable module, or a usage error).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScriptCheck, makeFixtureSrc as makeFixtureSrcShared } from '../../tools/audit/gates/test-utils.js';
import { makeRepoSandbox } from '../../tools/test-helpers/repo-sandbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'tools', 'audit', 'gates', 'check-module-intent.mjs');
const CI_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

function runCheck(extraArgs: string[] = []) {
  return runScriptCheck(SCRIPT, REPO_ROOT, extraArgs);
}

function makeFixtureSrc(files: Record<string, string>) {
  return makeFixtureSrcShared('module-intent-', files);
}

describe('check-module-intent CLI (DR-7/DR-8)', () => {
  it('Script_Exists', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('SyntheticOrphan_NoHeaderNoClass_Fails', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'widgets/orphan-widget.ts': 'export const orphan = () => 1;\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/widgets\/orphan-widget\.ts/);
      expect(stderr).toMatch(/no RESERVED.*header and no allowlist class/);
    } finally {
      cleanup();
    }
  });

  /** An expired RESERVED header fails, so the owner must adopt or delete the module at expiry. */
  it('ExpiredReserved_Fails', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'legacy/old-thing.ts':
        '// RESERVED(issue: #123, owner: exarchos, expires: 2000-01-01) — long overdue\n' +
        'export const old = 1;\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/legacy\/old-thing\.ts/);
      expect(stderr).toMatch(/expired on 2000-01-01/);
    } finally {
      cleanup();
    }
  });

  /** Text after the date in the `expires` field, such as `; see also #1609`, makes the field invalid. */
  it('PollutedExpires_Fails', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'runtime/shim.ts':
        '// RESERVED(issue: #1590, owner: exarchos, expires: 2099-01-31; see also #1609) — stub\n' +
        'export const shim = 1;\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/runtime\/shim\.ts/);
      expect(stderr).toMatch(/expires must be a clean YYYY-MM-DD date/);
    } finally {
      cleanup();
    }
  });

  /** An issue ref without `#` is malformed. */
  it('MalformedIssueRef_Fails', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'legacy/bad-issue.ts':
        '// RESERVED(issue: 1590, owner: exarchos, expires: 2099-01-01) — stub\n' +
        'export const x = 1;\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/issue ref must be/);
    } finally {
      cleanup();
    }
  });

  it('MissingOwner_Fails', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'legacy/no-owner.ts':
        '// RESERVED(issue: #1590, expires: 2099-01-01) — stub\n' + 'export const x = 1;\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/owner is required/);
    } finally {
      cleanup();
    }
  });

  /** The reachability detector throws. A gate that passes when its scanner crashes gives no protection, so the gate exits 2. */
  it('ScanCrash_FailsClosed', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'placeholder.ts': 'export const x = 1;\n',
      'boom.mjs': 'throw new Error("refgraph exploded");\n',
    });
    try {
      const { status, stderr } = runCheck([
        '--src-root',
        srcRoot,
        '--refgraph',
        path.join(srcRoot, 'boom.mjs'),
      ]);
      expect(status).toBe(2);
      expect(stderr).toMatch(/reachability scan failed \(fail-closed\)/);
    } finally {
      cleanup();
    }
  });

  /** A RESERVED header with a future date and members of the allowlist classes pass in one tree. */
  it('ValidReservedAndClassAllowlist_Pass', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'keep/reserved-thing.ts':
        '// RESERVED(issue: #1590, owner: exarchos, expires: 2099-01-01) — reserved stub\n' +
        'export const kept = 1;\n',
      'dispatch/core/dispatch.economy-seam.ts': 'export const lint = () => [];\n',
      'workflow/test-helpers/util.ts': 'export const help = 1;\n',
      'event-store/decide-fixtures.ts': 'export const fx = {};\n',
      'storage/__shims__/bun-sqlite-node.ts': 'export const shim = 1;\n',
      'launcher/harness-registry.type-test.ts': 'export type T = 1;\n',
      'benchmarks/event-factories.ts': 'export const make = () => ({});\n',
      'projections/gwt.ts': 'export const given = 1;\n',
      'architecture/import-cycles.ts': 'export const detect = () => [];\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status, `stderr: ${stderr}`).toBe(0);
    } finally {
      cleanup();
    }
  });

  /**
   * A `*-schema.ts` file under `benchmarks/` is a contract surface, not benchmark data.
   * The benchmark class excludes it, so it needs a RESERVED header.
   */
  it('BenchmarkSchema_IsNotAllowlisted_Fails', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'benchmarks/baselines-schema.ts': 'export const Schema = {};\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/benchmarks\/baselines-schema\.ts/);
    } finally {
      cleanup();
    }
  });

  /** On the live tree with the default root, each module with no production importer declares valid intent. */
  it('ConformingRealTree_Pass', () => {
    const { status, stderr } = runCheck();
    expect(status, `stderr: ${stderr}`).toBe(0);
  });

  /**
   * The default root set must reach root `src/`: a dead module there fails a run with no `--src-root`.
   * The gate finds its repository from its own location.
   * Thus the test runs a copy of the gate in a sandbox that holds the gate, its detector and a small `src/`.
   * The sandbox scans clean first, so the failure comes from the probe file.
   */
  it('DefaultRootSet_CoversRootSrc_NotOnlyTheMcpPackage', async () => {
    const sandbox = await makeRepoSandbox({
      prefix: 'module-intent-root',
      copy: ['tools/audit/gates/check-module-intent.mjs', 'tools/audit/refgraph.mjs'],
      files: { 'src/index.ts': 'export const entry = 1;\n' },
    });
    const sandboxScript = sandbox.path('tools/audit/gates/check-module-intent.mjs');
    try {
      expect(runScriptCheck(sandboxScript, sandbox.root).status, 'the sandbox must scan clean before the probe').toBe(0);
      sandbox.write('src/dr9-root-src-probe.ts', 'export const probe = () => 1;\n');
      const { status, stderr } = runScriptCheck(sandboxScript, sandbox.root);
      expect(status, 'a dead module in root `src/` must fail the DEFAULT invocation').toBe(1);
      expect(stderr).toMatch(/src\/dr9-root-src-probe\.ts/);
      expect(stderr).toMatch(/no RESERVED.*header and no allowlist class/);
    } finally {
      sandbox.remove();
    }
  });

  /**
   * `src/install/friction-signal.ts` must carry a RESERVED marker with an issue, an owner and an expiry in the future.
   * The marker schedules a deletion. It is not an exemption.
   * The last assertion rejects a header sentence that claims the file location satisfies the gate.
   */
  it('FrictionSignal_DeclaresIntentRatherThanEvadingTheGate', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'src', 'install', 'friction-signal.ts'),
      'utf8',
    );
    const marker = /RESERVED\(issue:\s*#(\d+),\s*owner:\s*(\S+?),\s*expires:\s*(\d{4}-\d{2}-\d{2})\)/.exec(
      source,
    );
    expect(marker, 'friction-signal.ts must declare its intent in-file').not.toBeNull();
    expect(Date.parse(`${marker?.[3]}T00:00:00Z`)).toBeGreaterThan(Date.now());
    expect(source).not.toMatch(/would itself register as dead-in-prod \(DR-7\)[\s\S]{0,40}the opposite/);
  });

  /**
   * `src/lifecycle/install-skills-bridge.js` imports `src/install/runtimes/embedded.js`, a shim that re-exports the `.ts` original.
   * refgraph reads only `.ts` files, so it does not see that edge.
   * The first assertion pins the import in the bridge, so the test cannot pass on a bridge that omits it.
   * The explicit `src` scan must not report `embedded.ts`, and that file must carry no RESERVED declaration.
   */
  it('CrossRootImporter_KeepsAModuleOutOfTheDeadSet', () => {
    const bridge = readFileSync(
      path.join(REPO_ROOT, 'src', 'lifecycle', 'install-skills-bridge.js'),
      'utf8',
    );
    expect(bridge, 'the live import edge this sweep exists for').toMatch(
      /from '\.\.\/install\/runtimes\/embedded\.js'/,
    );
    const { status, stderr } = runCheck(['--src-root', path.join(REPO_ROOT, 'src')]);
    expect(status, `stderr: ${stderr}`).toBe(0);
    expect(stderr).not.toMatch(/runtimes\/embedded\.ts/);
    const embedded = readFileSync(
      path.join(REPO_ROOT, 'src', 'install', 'runtimes', 'embedded.ts'),
      'utf8',
    );
    expect(embedded).not.toMatch(/RESERVED\(/);
  });

  /**
   * `npm run hooks:guard` is an alias of `render:guard`, which runs the build output of `src/install/render-guard.ts`.
   * The filename regex that refgraph uses for entry points can miss such a script subject.
   * The explicit `src` scan must not report `render-guard.ts`, and that file must carry no RESERVED declaration.
   */
  it('NpmScriptEntrypoint_KeepsAModuleOutOfTheDeadSet', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['hooks:guard']).toMatch(/render:guard/);
    expect(pkg.scripts?.['render:guard']).toMatch(/dist\/install\/render-guard\.js/);
    const { status, stderr } = runCheck(['--src-root', path.join(REPO_ROOT, 'src')]);
    expect(status, `stderr: ${stderr}`).toBe(0);
    expect(stderr).not.toMatch(/render-guard\.ts/);
    const guardSource = readFileSync(
      path.join(REPO_ROOT, 'src', 'install', 'render-guard.ts'),
      'utf8',
    );
    expect(guardSource).not.toMatch(/RESERVED\(/);
  });

  /**
   * A `-seam.ts` suffix is not an intent declaration, so a new dead `-seam.ts` module fails.
   * The declared seam modules are named members with an owner, and the live tree still passes.
   */
  it('SeamFilenameAlone_NoLongerGrantsAnExemption', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'architecture/brand-new-seam.ts': 'export const lint = () => [];\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status, 'a filename suffix is not an intent declaration').toBe(1);
      expect(stderr).toMatch(/architecture\/brand-new-seam\.ts/);
    } finally {
      cleanup();
    }
    expect(runCheck().status).toBe(0);
  });

  /**
   * A `declared-dormant-surface` member keeps its issue and expiry in the register of the gate, not in the file.
   * `OUT_OF_SUBJECT` skips `install/`, where the live members are.
   * The test pins the `expires` field of one member in the gate source.
   * It also pins that a fixture at that key stays skipped: the gate exits 0 before and after the expiry date.
   */
  it('DormantSurfaceMemberPastItsExpiry_Fails', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).toMatch(/'install\/wizard\/wizard\.ts': \{[\s\S]*?expires: '2027-02-28'/);

    const { srcRoot, cleanup } = makeFixtureSrc({
      'install/wizard/wizard.ts': 'export const run = () => 1;\n',
    });
    try {
      const clean = runCheck(['--src-root', srcRoot, '--now', '2026-08-09']);
      expect(clean.status, `stderr: ${clean.stderr}`).toBe(0);

      const afterSkip = runCheck(['--src-root', srcRoot, '--now', '2099-01-01']);
      expect(afterSkip.status, `stderr: ${afterSkip.stderr}`).toBe(0);
      expect(afterSkip.stderr).not.toMatch(/wizard/);
    } finally {
      cleanup();
    }
  });

  /**
   * A module that only mentions `RESERVED(...)` in prose carries no declaration.
   * The parser takes the first occurrence that holds a declared field, so the real marker on the second line counts.
   */
  it('ReservedMentionedInProse_IsNotReadAsADeclaration', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'prose/mentions-it.ts':
        '// This module is governed the same way a RESERVED(...) stub is.\n' +
        '// RESERVED(issue: #1590, owner: exarchos, expires: 2099-01-01) — the real marker\n' +
        'export const x = 1;\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status, `stderr: ${stderr}`).toBe(0);
    } finally {
      cleanup();
    }
  });

  /**
   * Reads the member entries from the source of the gate: each one must hold an `owner` and a `rationale`.
   * `validateClassMember` enforces the same rule at runtime.
   */
  it('EveryDeclaredMember_CarriesAnOwnerAndARationale', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const memberBlocks = source.match(/^\s{6}'[^']+': \{\n(?:\s{8}.*\n)+?\s{6}\},$/gm) ?? [];
    expect(memberBlocks.length, 'enumerated members').toBeGreaterThan(15);
    for (const block of memberBlocks) {
      expect(block, `member missing owner:\n${block}`).toMatch(/\bowner:\s*'/);
      expect(block, `member missing rationale:\n${block}`).toMatch(/\brationale:\s*\n?\s*'/);
    }
  });

  /**
   * A skip rule for a directory that does not exist stops skipping without a signal.
   * Thus the test pins both halves: the script declares `OUT_OF_SUBJECT`, and each prefix exists under `src/`.
   * A capture group has type `string | undefined`, so the filter removes the `undefined` case before `path.join`.
   */
  it('ModuleIntent_OutOfSubjectPrefixes_AllExist', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    const declared = /const OUT_OF_SUBJECT = \[([^\]]*)\]/.exec(script);
    expect(declared, 'OUT_OF_SUBJECT must be declared in the script').not.toBeNull();
    const prefixes = [...(declared?.[1] ?? '').matchAll(/'([^']+)'/g)]
      .map((m) => m[1])
      .filter((p): p is string => p !== undefined);
    expect(prefixes.length).toBeGreaterThan(0);
    for (const prefix of prefixes) {
      expect(
        existsSync(path.join(REPO_ROOT, 'src', prefix)),
        `out-of-subject prefix "${prefix}" does not exist under src/`,
      ).toBe(true);
    }
  });

  it('Wired_Into_GrepGates_CI', () => {
    const ci = readFileSync(CI_WORKFLOW, 'utf8');
    expect(ci).toMatch(/node tools\/audit\/gates\/check-module-intent\.mjs/);
  });
});
