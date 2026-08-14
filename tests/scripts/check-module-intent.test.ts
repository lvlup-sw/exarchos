/**
 * Tests for the module-intent CI gate (DR-7, DR-8).
 *
 * The gate FAILS a production module under `src` that has
 * zero production importers unless it declares intent — either a valid
 * `RESERVED(issue, owner, expires)` header (well-formed issue ref + owner + a
 * clean, non-past expiry) or membership in a declared allowlist class
 * (test-infra / build-shim / type-test entrypoint). Reachability is delegated
 * to the vendored `tools/audit/refgraph.mjs` detector; any scan failure is
 * fail-closed (DR-8).
 *
 * Exit codes: 0 clean · 1 module-intent violation · 2 fail-closed (scan crash /
 * unreadable module / usage).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
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
    // The live tree: the 11 RESERVED + 11 class-allowlist dead-in-prod modules
    // all declare valid intent. This also pins the command-shim-emitter.ts
    // header normalization — if its expires field is re-polluted, this fails.
    const { status, stderr } = runCheck();
    expect(status, `stderr: ${stderr}`).toBe(0);
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
