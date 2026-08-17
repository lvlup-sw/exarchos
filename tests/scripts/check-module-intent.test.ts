/**
 * Tests for the module-intent CI gate (DR-7, DR-8).
 *
 * The gate FAILS a production module under `src` that has
 * zero production importers unless it declares intent — either a valid
 * `RESERVED(issue, owner, expires)` header (well-formed issue ref + owner + a
 * clean, non-past expiry) or membership in a declared allowlist class, whose
 * enumerated members each carry an owner and a rationale. Reachability is
 * delegated to the vendored `tools/audit/refgraph.mjs` detector, widened by
 * two evidence-based sweeps (cross-root importers, npm-script entrypoints); any
 * scan failure is fail-closed (DR-8).
 *
 * Exit codes: 0 clean · 1 module-intent violation · 2 fail-closed (scan crash /
 * unreadable module / usage).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScriptCheck, makeFixtureSrc as makeFixtureSrcShared } from '../../tools/audit/gates/test-utils.js';

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

  // ── Direction 1: dead-in-prod without valid intent → FAIL (exit 1) ─────────

  it('SyntheticOrphan_NoHeaderNoClass_Fails', () => {
    // A brand-new production module with 0 importers, no RESERVED header, and no
    // allowlist class is exactly what DR-7 exists to catch.
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

  it('ExpiredReserved_Fails', () => {
    // An expired-and-unadopted RESERVED stub is the DR-7 "deletion happens at
    // expiry" enforcement point.
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

  it('PollutedExpires_Fails', () => {
    // The exact pollution normalized out of command-shim-emitter.ts: a trailing
    // "; see also #NNNN" inside the expires field makes it un-parseable as a
    // clean date. The gate must reject it (which is what forces the header to be
    // normalized so the real tree scans clean).
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

  it('MalformedIssueRef_Fails', () => {
    // A missing "#" is not a well-formed issue ref.
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

  // ── Fail-closed: a crashing detector must never pass (exit 2, DR-8) ─────────

  it('ScanCrash_FailsClosed', () => {
    // Point the gate at a reachability detector that throws. A gate that
    // silently no-ops when its scanner crashes is a gate that isn't there.
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

  // ── Direction 2: declared intent → PASS (exit 0) ───────────────────────────

  it('ValidReservedAndClassAllowlist_Pass', () => {
    // A valid future-dated RESERVED header AND each allowlist class (seam,
    // test-helper, fixtures, shim, type-test, benchmark) all pass together.
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

  it('BenchmarkSchema_IsNotAllowlisted_Fails', () => {
    // A `*-schema.ts` under benchmarks/ is a contract surface, NOT benchmark
    // test-data — it is deliberately excluded from the benchmark-harness class
    // so its RESERVED-expiry stays enforced. Without a header it must fail.
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

  it('ConformingRealTree_Pass', () => {
    // The live tree, BOTH source roots: every dead-in-prod module declares valid
    // intent. This also pins the command-shim-emitter.ts header normalization —
    // if its expires field is re-polluted, this fails.
    const { status, stderr } = runCheck();
    expect(status, `stderr: ${stderr}`).toBe(0);
  });

  // ── Direction 3: the gate's ROOT SET covers root `src/` (DR-9) ─────────────

  it('DefaultRootSet_CoversRootSrc_NotOnlyTheMcpPackage', () => {
    // The gate's default root was the MCP package alone, so root `src/` was
    // outside it entirely. `friction-signal.ts` states in its own header that it
    // was placed there partly BECAUSE a module elsewhere "would itself register
    // as dead-in-prod (DR-7)" — relocating out of a gate's reach is not
    // satisfying the gate, so the reach is what moved.
    //
    // Driven through the real CLI: a fresh dead module dropped into root `src/`
    // must be REPORTED by a default (no `--src-root`) invocation. Naming the
    // default root list in an assertion would only restate the constant.
    const orphan = path.join(REPO_ROOT, 'src', 'dr9-root-src-probe.ts');
    writeFileSync(orphan, 'export const probe = () => 1;\n', 'utf8');
    try {
      const { status, stderr } = runCheck();
      expect(status, 'a dead module in root `src/` must fail the DEFAULT invocation').toBe(1);
      expect(stderr).toMatch(/src\/dr9-root-src-probe\.ts/);
      expect(stderr).toMatch(/no RESERVED.*header and no allowlist class/);
    } finally {
      rmSync(orphan, { force: true });
    }
    // …and removing it restores the clean verdict, so the failure was the probe.
    expect(runCheck().status).toBe(0);
    // Two full-tree CLI spawns, where every sibling case spends one. A 2-core
    // Windows runner needs ~3.4s per scan, so the default 5s budget cannot fit
    // both — the timeout was arithmetic, not a slow gate.
  }, 30_000);

  it('FrictionSignal_DeclaresIntentRatherThanEvadingTheGate', () => {
    // The specific module DR-9 names. It lives under `src/install/` after the
    // fold and must still satisfy DR-7: a RESERVED marker with an owner, an
    // issue and a live expiry — i.e. a scheduled deletion, not an exemption.
    const source = readFileSync(
      path.join(REPO_ROOT, 'src', 'install', 'friction-signal.ts'),
      'utf8',
    );
    const marker = /RESERVED\(issue:\s*#(\d+),\s*owner:\s*(\S+?),\s*expires:\s*(\d{4}-\d{2}-\d{2})\)/.exec(
      source,
    );
    expect(marker, 'friction-signal.ts must declare its intent in-file').not.toBeNull();
    expect(Date.parse(`${marker?.[3]}T00:00:00Z`)).toBeGreaterThan(Date.now());
    // The header's original placement note claimed the relocation ANSWERED DR-7.
    // That claim is what the correction had to remove, so it must not survive.
    expect(source).not.toMatch(/would itself register as dead-in-prod \(DR-7\)[\s\S]{0,40}the opposite/);
  });

  it('CrossRootImporter_KeepsAModuleOutOfTheDeadSet', () => {
    // `src/install/runtimes/embedded.ts` is imported by the plain-JS bridge at
    // `src/lifecycle/install-skills-bridge.js`, which refgraph does not read
    // (wrong extension). Widening the root set without the importer sweep would
    // have reported a module the shipped binary statically depends on as dead —
    // and the only way to make the gate green would have been to declare a
    // falsehood about it.
    //
    // The bridge's `import` statements name `.js` siblings that re-export from
    // the `.ts` originals (see `src/install/runtimes/embedded.js` and
    // `src/install/install-skills.js`) so vite-node finds a literal `.js` file
    // at the specifier path and bun's `--compile` bundler follows the
    // re-exports into the binary. The assertion below pins the live import
    // edge in the bridge so the test cannot pass on a bridge that no longer
    // references the subject module — the proof gate, not the allowlist,
    // decides whether `embedded.ts` is reported as dead.
    const bridge = readFileSync(
      path.join(REPO_ROOT, 'src', 'lifecycle', 'install-skills-bridge.js'),
      'utf8',
    );
    expect(bridge, 'the live import edge this sweep exists for').toMatch(
      /from '\.\.\/install\/runtimes\/embedded\.js'/,
    );
    // Its subject is therefore NOT reported, and carries no declaration either —
    // it is answered by evidence, not by an allowlist entry. Driven with an
    // EXPLICIT root-`src/` scan so the assertion cannot be satisfied by a gate
    // that simply never looks there.
    const { status, stderr } = runCheck(['--src-root', path.join(REPO_ROOT, 'src')]);
    expect(status, `stderr: ${stderr}`).toBe(0);
    expect(stderr).not.toMatch(/runtimes\/embedded\.ts/);
    const embedded = readFileSync(
      path.join(REPO_ROOT, 'src', 'install', 'runtimes', 'embedded.ts'),
      'utf8',
    );
    expect(embedded).not.toMatch(/RESERVED\(/);
  });

  it('NpmScriptEntrypoint_KeepsAModuleOutOfTheDeadSet', () => {
    // `npm run hooks:guard` is an alias of `render:guard`, which runs
    // `node dist/install/render-guard.js` — the build output of
    // `src/install/render-guard.ts`. refgraph's entry set is a hand-written
    // filename regex that can miss a live CI entrypoint and read it as dead.
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['hooks:guard']).toMatch(/render:guard/);
    expect(pkg.scripts?.['render:guard']).toMatch(/dist\/install\/render-guard\.js/);
    // Explicit root, same reason as the cross-root case above.
    const { status, stderr } = runCheck(['--src-root', path.join(REPO_ROOT, 'src')]);
    expect(status, `stderr: ${stderr}`).toBe(0);
    expect(stderr).not.toMatch(/render-guard\.ts/);
    const guardSource = readFileSync(
      path.join(REPO_ROOT, 'src', 'install', 'render-guard.ts'),
      'utf8',
    );
    expect(guardSource).not.toMatch(/RESERVED\(/);
  });

  // ── Direction 4: declared classes are OWNED, and per-module (DR-7) ─────────

  it('SeamFilenameAlone_NoLongerGrantsAnExemption', () => {
    // The blanket `/-seam\.ts$/` rule granted any such basename a permanent,
    // unowned pass — a NAME standing in for a property, the shape this programme
    // keeps repairing. A NEW dead `-seam.ts` must now be declared like anything
    // else, and the five real members are enumerated with owners instead.
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
    // …while the five that ARE declared keep passing on the live tree.
    expect(runCheck().status).toBe(0);
  });

  it('DormantSurfaceMemberPastItsExpiry_Fails', () => {
    // A `declared-dormant-surface` member is a RESERVED marker kept in the
    // register rather than the file, so it owes the same live expiry. Live
    // members sit under `install/`, which OUT_OF_SUBJECT skips — pin the
    // register fields so that skip cannot drop the deadline, and pin that a
    // fixture at the register key stays skipped rather than reclassified.
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

  it('ReservedMentionedInProse_IsNotReadAsADeclaration', () => {
    // `parseReserved` took the FIRST `RESERVED(` in the file, so a module that
    // merely DISCUSSES the mechanism ("the same enforcement philosophy as the
    // `RESERVED(...)` module-intent gate" — shim-registry.ts, advisory-registry.ts)
    // was read as carrying a header with three missing fields. A mention is not a
    // declaration; carrying a declared FIELD is what tells them apart.
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

  it('EveryDeclaredMember_CarriesAnOwnerAndARationale', () => {
    // The criterion itself, read off the gate's own source rather than restated:
    // no enumerated member may be a bare path. `validateClassMember` enforces it
    // at runtime; this pins that no member was added without the fields.
    const source = readFileSync(SCRIPT, 'utf8');
    const memberBlocks = source.match(/^\s{6}'[^']+': \{\n(?:\s{8}.*\n)+?\s{6}\},$/gm) ?? [];
    expect(memberBlocks.length, 'enumerated members').toBeGreaterThan(15);
    for (const block of memberBlocks) {
      expect(block, `member missing owner:\n${block}`).toMatch(/\bowner:\s*'/);
      expect(block, `member missing rationale:\n${block}`).toMatch(/\brationale:\s*\n?\s*'/);
    }
  });

  // ── CI wiring ──────────────────────────────────────────────────────────────


  // ── Subject scope ──────────────────────────────────────────────────────────

  it('ModuleIntent_OutOfSubjectPrefixes_AllExist', () => {
    // The census skips subtrees entered from outside the engine's import graph.
    // A skip rule naming a directory that is gone would quietly stop skipping —
    // or, worse, read as coverage the census does not have. Both halves are
    // pinned: the rule is declared in the script, and its target is on disk.
    const script = readFileSync(SCRIPT, 'utf8');
    const declared = /const OUT_OF_SUBJECT = \[([^\]]*)\]/.exec(script);
    expect(declared, 'OUT_OF_SUBJECT must be declared in the script').not.toBeNull();
    // A capture group is `string | undefined` to the checker even when the
    // pattern guarantees it, so the absent case is dropped rather than asserted
    // away — an unmatched group would otherwise reach `path.join` as undefined.
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
