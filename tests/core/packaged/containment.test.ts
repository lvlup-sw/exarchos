/**
 * DR-21 / T-29 — generated-projection containment proven against PACKED BYTES.
 *
 * ## The defect this replaces
 *
 * The previous headline proof (`src/install/projection-containment.packaging.test.ts`)
 * derived BOTH sides of the comparison from one read: `enumerateProjections()`
 * produced a `contents` map, the required inventory was digested from that map,
 * and the "packaged layer" was `packagedLayerFromContents(contents)` — the same
 * map again. A map compared with itself cannot disagree. Deleting a real agent,
 * alias or hook shrank both sides together and the proof stayed green, so it
 * carried no information about the shipped artifact at all.
 *
 * ## What this suite does instead
 *
 * Two genuinely independent reads:
 *
 *   Authority A — the AUTHORED SOURCE TREE. `enumerateProjections(repoRoot)`
 *     walks the committed projection roots (`skills/`, `command-aliases/`,
 *     `agents/`, `hooks/`, `.claude-plugin/plugin.json`, `AGENTS.md`) and says
 *     what MUST ship, with an expected content digest per projection.
 *
 *   Authority B — the PACKED TARBALL BYTES. A real `npm pack` runs against the
 *     real repository, the real `.tgz` is unpacked with a real `tar`, and
 *     `readPackedProjectionLayer()` reads the packaged layer out of THOSE BYTES.
 *     Nothing on this side is derived from Authority A.
 *
 * Containment is then a digest comparison across the seam. Because the sides are
 * two reads, they CAN disagree — which is exactly what the two seeded fixtures
 * below demonstrate: deleting one projection file from the unpacked tarball
 * fails with `missing`, and rewriting one projection file's bytes fails with
 * `content-mismatch`.
 *
 * ## Delivery-mode scope (honesty note)
 *
 * Only `npm-files` projections can be observed as tarball entries. The `runtime`
 * kind is codegen'd into `src/install/runtimes/embedded.ts` and compiled into the
 * single-file binary (`dist/bin`), so it is deliberately out of scope here —
 * `checkShippedCoverage` remains its proof. `npmFilesSpecs()` makes that
 * exclusion explicit rather than accidental.
 *
 * @oracle-sources: authored projection tree committed in the repository working copy, npm pack tarball bytes unpacked from the generated archive
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { digestText } from '../../../src/install/artifact-agreement.js';
import {
  PackedContainmentError,
  assertPackedContainment,
  classifyProjectionPath,
  enumerateProjections,
  npmFilesSpecs,
  readPackedProjectionLayer,
  verifyContainment,
  verifyPackedContainment,
  type ContainmentResult,
  type ProjectionKind,
  type RequiredProjection,
} from '../../../src/install/projection-containment.js';
import { needsWindowsShell } from '../../../src/utils/process.js';

// ─── Repo-root discovery ─────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(startDir: string): string {
  let cursor = path.resolve(startDir);
  for (let i = 0; i < 10; i += 1) {
    if (
      fs.existsSync(path.join(cursor, 'package.json')) &&
      fs.existsSync(path.join(cursor, 'tools', 'release', 'build-binary.ts'))
    ) {
      return cursor;
    }
    const next = path.dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  throw new Error(`unable to locate repo root from ${startDir}`);
}

const REPO_ROOT = findRepoRoot(HERE);

// ─── Real `npm pack` + real `tar` (no hand-rolled archive handling) ──────────

/**
 * Run the REAL `npm pack` against the repository and return the tarball path.
 *
 * `--ignore-scripts` skips the `prepare` (`tsc`) lifecycle: it emits only
 * `dist/**`, none of which is a projection, and running it would make this
 * suite depend on a compile rather than on the packaging manifest.
 */
function runNpmPack(repoRoot: string, destDir: string): string {
  fs.mkdirSync(destDir, { recursive: true });
  const useShell = needsWindowsShell('npm');
  const res = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', destDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    ...(useShell ? { shell: true } : {}),
  });
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(
      `npm pack failed (exit ${String(res.status)}${
        res.error === undefined ? '' : `, ${res.error.message}`
      }):\n${res.stdout ?? ''}\n${res.stderr ?? ''}`,
    );
  }
  const tarballs = fs.readdirSync(destDir).filter((f) => f.endsWith('.tgz'));
  const only = tarballs[0];
  if (tarballs.length !== 1 || only === undefined) {
    throw new Error(`expected exactly one .tgz in ${destDir}, found: ${tarballs.join(', ') || '<none>'}`);
  }
  return path.join(destDir, only);
}

/**
 * Unpack `tarball` with the REAL `tar` binary and return the `package/` dir.
 *
 * The archive is copied next to the extraction point and invoked by a BARE
 * RELATIVE name from that cwd: GNU tar parses an absolute Windows path
 * (`C:\…`) as a `host:path` remote spec and fails with "Cannot connect to C",
 * while bsdtar accepts it. A relative name from `cwd` works under both.
 */
function extractTarball(tarball: string, intoDir: string): string {
  fs.mkdirSync(intoDir, { recursive: true });
  const local = path.join(intoDir, 'artifact.tgz');
  fs.copyFileSync(tarball, local);
  const res = spawnSync('tar', ['-xzf', 'artifact.tgz'], {
    cwd: intoDir,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(
      `tar extraction failed (exit ${String(res.status)}${
        res.error === undefined ? '' : `, ${res.error.message}`
      }):\n${res.stdout ?? ''}\n${res.stderr ?? ''}`,
    );
  }
  const packageDir = path.join(intoDir, 'package');
  if (!fs.existsSync(packageDir)) {
    throw new Error(`tarball did not contain a package/ root: ${tarball}`);
  }
  return packageDir;
}

// ─── Fixture state ───────────────────────────────────────────────────────────

let workDir = '';
/** The pristine, unmodified unpacked tarball — never mutated. */
let pristinePackageDir = '';
/** The `npm-files` projection kinds, i.e. the ones observable as tarball entries. */
const PACKED_KINDS: readonly ProjectionKind[] = npmFilesSpecs().map((s) => s.kind);
/** Authority A, read once from the source tree. */
let sourceProjections: readonly RequiredProjection[] = [];

function firstOfKind(kind: ProjectionKind): RequiredProjection {
  const found = sourceProjections.find((p) => p.kind === kind);
  if (found === undefined) throw new Error(`no source projection enumerated for kind '${kind}'`);
  return found;
}

/** Copy the pristine unpacked package into a fresh scratch tree. */
function scratchCopy(label: string): string {
  const dest = path.join(workDir, `scratch-${label}`, 'package');
  fs.rmSync(path.dirname(dest), { recursive: true, force: true });
  fs.cpSync(pristinePackageDir, dest, { recursive: true });
  return dest;
}

/**
 * Re-read the (possibly mutated) packed tree off disk and check it against the
 * source-tree inventory captured in `beforeAll` — i.e. the same two-authority
 * comparison `verifyPackedContainment` performs, but without re-walking the
 * ~1k-file source tree on every sweep iteration.
 *
 * This is NOT a shortcut around the seam: side B is still read fresh from the
 * archive bytes after each mutation, and side A was read from the source tree
 * BEFORE any mutation, so the two can still disagree. The fully composed
 * `verifyPackedContainment` / `assertPackedContainment` path (which re-reads
 * both authorities itself) is exercised end-to-end in every test below.
 */
function verifyPackedAgainstSource(packageDir: string): ContainmentResult {
  const packed = readPackedProjectionLayer(packageDir);
  return verifyContainment({ required: sourceProjections, layers: [packed.layer] });
}

/**
 * The hook below shells out to `npm pack` over the whole package and walks the
 * ~1k-file projection tree: ~31s on ubuntu-latest, 47s to over 60s on
 * windows-latest, which is the core tier's entire hook budget. The budget here
 * is this hook's own, not the tier's; a genuine hang still fails, just later.
 */
const PACK_HOOK_TIMEOUT_MS = 180_000;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-t29-packed-'));
  const tarball = runNpmPack(REPO_ROOT, path.join(workDir, 'tgz'));
  pristinePackageDir = extractTarball(tarball, path.join(workDir, 'pristine'));
  sourceProjections = enumerateProjections(REPO_ROOT, npmFilesSpecs()).projections;
}, PACK_HOOK_TIMEOUT_MS);

afterAll(() => {
  if (workDir !== '') fs.rmSync(workDir, { recursive: true, force: true });
});

// ─── The headline proof, over real packed bytes ──────────────────────────────

describe('projection containment against packed bytes', () => {
  it('unpacks a real npm pack tarball carrying real projection bytes', () => {
    const packed = readPackedProjectionLayer(pristinePackageDir);
    // Anti-vacuity: the archive must actually carry the fan-out, and the
    // projection subset must be a proper subset of everything packed.
    expect(packed.paths.length).toBeGreaterThan(40);
    expect(packed.totalFiles).toBeGreaterThan(packed.paths.length);
    // The bytes come off disk from the archive, not from the source tree.
    for (const kind of PACKED_KINDS) {
      const anyOfKind = packed.paths.some((p) => classifyProjectionPath(p, npmFilesSpecs()) === kind);
      expect(anyOfKind, `packed tarball carries no ${kind} projection`).toBe(true);
    }
  });

  it('every authored projection is present in the tarball byte-for-byte', () => {
    const result = assertPackedContainment({ repoRoot: REPO_ROOT, packageDir: pristinePackageDir });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.unexpected).toHaveLength(0);
    expect(result.checked).toBeGreaterThan(40);
    expect(result.packedCount).toBe(result.checked);
  });

  /**
   * The anti-circularity claim itself. DR-21's finding was that both sides came
   * from one map, so a change to the artifact necessarily changed the
   * expectation too. Here the source-tree inventory is read BEFORE the tarball
   * is mutated and is *unaffected* by that mutation — the two authorities move
   * independently, which is the property that makes every assertion below
   * capable of failing.
   */
  it('the inventory authority is independent of the packed artifact', () => {
    const scratch = scratchCopy('independence');
    const before = readPackedProjectionLayer(scratch);
    const victim = firstOfKind('agent');

    fs.rmSync(path.join(scratch, victim.path));

    const after = readPackedProjectionLayer(scratch);
    // Side B shrank …
    expect(after.paths.length).toBe(before.paths.length - 1);
    expect(after.paths).not.toContain(victim.path);
    // … while side A, re-read from the untouched source tree, did NOT.
    const reread = enumerateProjections(REPO_ROOT, npmFilesSpecs()).projections;
    expect(reread.length).toBe(sourceProjections.length);
    expect(reread.some((p) => p.path === victim.path)).toBe(true);
  });
});

// ─── Seeded fixture 1: a DELETED projection file ─────────────────────────────

describe('seeded packed-artifact defects', () => {
  /**
   * BLOCKING CLAIM — a projection dropped from the shipped tarball must fail
   * verification, for every `npm-files` projection kind independently.
   *
   * @kill-seam: the packed bytes read off disk by readPackedProjectionLayer — delete one projection file from the unpacked tarball and the source-tree inventory still requires it, so verification must report `missing`
   *
   * NEGATIVE TWIN — the same scratch tree, restored, passes again; that is what
   * attributes the red to the deletion rather than to the fixture setup.
   */
  it('PackedContainment_DeletedProjectionFile_FailsVerification', () => {
    const scratch = scratchCopy('deleted');

    for (const kind of PACKED_KINDS) {
      const victim = firstOfKind(kind);
      const abs = path.join(scratch, victim.path);
      const saved = fs.readFileSync(abs, 'utf8');

      fs.rmSync(abs);
      expect(fs.existsSync(abs)).toBe(false);

      const result = verifyPackedAgainstSource(scratch);
      expect(result.ok, `deleting packed ${kind} '${victim.path}' did not fail verification`).toBe(false);

      const violation = result.violations.find((v) => v.id === victim.id);
      expect(violation, `no violation raised for deleted ${kind} '${victim.path}'`).toBeDefined();
      expect(violation?.kind).toBe('missing');
      expect(violation?.projection).toBe(kind);
      expect(violation?.detail).toContain(victim.path);

      // NEGATIVE TWIN: restore the byte-identical file → green again.
      fs.writeFileSync(abs, saved, 'utf8');
      const restored = verifyPackedAgainstSource(scratch);
      expect(restored.ok, `restoring packed ${kind} '${victim.path}' did not return to green`).toBe(true);
    }

    // The assertion helper fails closed with a typed, attributable error.
    const agent = firstOfKind('agent');
    fs.rmSync(path.join(scratch, agent.path));
    let thrown: unknown;
    try {
      assertPackedContainment({ repoRoot: REPO_ROOT, packageDir: scratch });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PackedContainmentError);
    expect((thrown as PackedContainmentError).message).toContain(agent.path);
    expect((thrown as PackedContainmentError).message).toContain('missing');
  });

  /**
   * BLOCKING CLAIM — a projection whose bytes were rewritten in the shipped
   * tarball must fail verification. Same path, different content: a
   * path-existence check would pass, so only a content digest can catch it.
   *
   * @kill-seam: the content digest of the packed bytes versus the authored source digest — rewrite one packed projection file in place and verification must report `content-mismatch`, not merely `missing`
   *
   * NEGATIVE TWIN — rewriting the SAME logical content with CRLF line endings
   * must NOT fail: the digest is deliberately line-ending-canonical, so a red
   * there would mean the fixture detects any write rather than a real change.
   */
  it('PackedContainment_RewrittenProjectionBytes_FailsVerification', () => {
    const scratch = scratchCopy('rewritten');

    for (const kind of PACKED_KINDS) {
      const victim = firstOfKind(kind);
      const abs = path.join(scratch, victim.path);
      const saved = fs.readFileSync(abs, 'utf8');

      const tampered = `${saved}\nT29-TAMPERED-PROJECTION-BYTES\n`;
      // Guard the fixture itself: the rewrite must genuinely change the digest.
      expect(digestText(tampered)).not.toBe(digestText(saved));

      fs.writeFileSync(abs, tampered, 'utf8');
      expect(fs.existsSync(abs), 'the rewritten file must still exist at the same path').toBe(true);

      const result = verifyPackedAgainstSource(scratch);
      expect(result.ok, `rewriting packed ${kind} '${victim.path}' did not fail verification`).toBe(false);

      const violation = result.violations.find((v) => v.id === victim.id);
      expect(violation, `no violation raised for rewritten ${kind} '${victim.path}'`).toBeDefined();
      expect(violation?.kind).toBe('content-mismatch');
      expect(violation?.projection).toBe(kind);
      expect(violation?.detail).toContain(victim.digest);

      // NEGATIVE TWIN: a CRLF-only rewrite is the same content — still green.
      // Without this arm the fixture could be detecting "the file was written"
      // rather than "the content changed".
      fs.writeFileSync(abs, saved.replace(/\r?\n/g, '\r\n'), 'utf8');
      const crlf = verifyPackedAgainstSource(scratch);
      expect(crlf.ok, `a CRLF-only rewrite of ${kind} '${victim.path}' must not fail containment`).toBe(true);

      fs.writeFileSync(abs, saved, 'utf8');
    }

    // The assertion helper fails closed with a typed, attributable error.
    const agent = firstOfKind('agent');
    const abs = path.join(scratch, agent.path);
    fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\nT29-TAMPERED-PROJECTION-BYTES\n`, 'utf8');
    let thrown: unknown;
    try {
      assertPackedContainment({ repoRoot: REPO_ROOT, packageDir: scratch });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PackedContainmentError);
    expect((thrown as PackedContainmentError).message).toContain('content-mismatch');
    expect((thrown as PackedContainmentError).message).toContain(agent.path);
  });

  /**
   * The third direction: a projection SMUGGLED into the tarball that the
   * authored source tree does not require. The old single-map proof could not
   * express this at all, because an extra packed file would simply have been an
   * extra inventory entry.
   */
  it('an unauthored projection added to the tarball fails verification', () => {
    const scratch = scratchCopy('smuggled');
    const smuggled = 'rendered/agents/t29-not-in-the-source-tree.md';
    fs.writeFileSync(path.join(scratch, smuggled), '# smuggled agent\n', 'utf8');

    const result = verifyPackedContainment({ repoRoot: REPO_ROOT, packageDir: scratch });
    expect(result.ok).toBe(false);
    expect(result.unexpected).toContain(smuggled);
  });

  /**
   * Anti-vacuity for the reader itself: an EMPTY packed tree must throw rather
   * than report "0 required, 0 violations, all good".
   */
  it('an empty packed tree fails loudly instead of proving nothing', () => {
    const empty = path.join(workDir, 'empty-package');
    fs.rmSync(empty, { recursive: true, force: true });
    fs.mkdirSync(empty, { recursive: true });
    expect(() => readPackedProjectionLayer(empty)).toThrow(/ZERO projection files/);
    expect(() =>
      verifyPackedContainment({ repoRoot: REPO_ROOT, packageDir: path.join(workDir, 'never-unpacked') }),
    ).toThrow(/missing or not a directory/);
  });
});
