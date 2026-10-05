/**
 * Proves the containment of generated projections against the bytes of a real `npm pack` tarball.
 * The proof needs two independent reads, because a map compared with itself cannot disagree.
 *
 * - The source tree: `enumerateProjections` walks the committed projection roots and gives the
 *   expected digest of each projection.
 * - The tarball: a real `npm pack` runs, a real `tar` unpacks it, and
 *   `readPackedProjectionLayer` reads the packaged layer from those bytes only.
 *
 * The seeded fixtures show that the two reads can disagree. A deleted file reports `missing`, and
 * rewritten bytes report `content-mismatch`. Only `npm-files` kinds are tarball entries. The
 * build compiles the `runtime` kind into the binary, and `checkShippedCoverage` is its proof.
 *
 * @oracle-sources: authored projection tree committed in the repository working copy, npm pack tarball bytes unpacked from the generated archive
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { spawnAsync } from '../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

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

/**
 * The setup hook runs `npm pack` over the whole package and walks about 1000 projection files.
 * On Windows that takes the whole 60 s hook budget of the core tier, so this hook has its own
 * budget. A child that exceeds its own timeout gets `SIGKILL`, so a hung `npm pack` fails the hook.
 */
const PACK_CHILD_TIMEOUT_MS = 150_000;
const EXTRACT_CHILD_TIMEOUT_MS = 20_000;
const PACK_HOOK_TIMEOUT_MS = 180_000;

/**
 * Runs the real `npm pack` on the repository and returns the tarball path. `--ignore-scripts`
 * skips the `prepare` script (`tsc`), so the suite does not depend on a compile. That script emits
 * only `dist` files, and none of them is a projection.
 */
async function runNpmPack(repoRoot: string, destDir: string): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true });
  const res = await spawnAsync('npm', ['pack', '--ignore-scripts', '--pack-destination', destDir], {
    cwd: repoRoot,
    timeout: PACK_CHILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(
      `npm pack failed (exit ${String(res.status)}${
        res.error === undefined ? '' : `, ${res.error.message}`
      }):\n${res.stdout}\n${res.stderr}`,
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
 * Unpacks `tarball` with the real `tar` binary and returns the `package/` directory. The function
 * copies the archive into `intoDir` and gives `tar` a bare relative name. GNU tar reads an
 * absolute Windows path (`C:\…`) as a `host:path` remote spec and fails. A relative name works
 * with GNU tar and with bsdtar.
 */
async function extractTarball(tarball: string, intoDir: string): Promise<string> {
  fs.mkdirSync(intoDir, { recursive: true });
  const local = path.join(intoDir, 'artifact.tgz');
  fs.copyFileSync(tarball, local);
  const res = await spawnAsync('tar', ['-xzf', 'artifact.tgz'], {
    cwd: intoDir,
    timeout: EXTRACT_CHILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(
      `tar extraction failed (exit ${String(res.status)}${
        res.error === undefined ? '' : `, ${res.error.message}`
      }):\n${res.stdout}\n${res.stderr}`,
    );
  }
  const packageDir = path.join(intoDir, 'package');
  if (!fs.existsSync(packageDir)) {
    throw new Error(`tarball did not contain a package/ root: ${tarball}`);
  }
  return packageDir;
}

let workDir = '';
/** The unpacked tarball. No test changes it. */
let pristinePackageDir = '';
/** The `npm-files` projection kinds, which are the kinds that the tarball carries as files. */
const PACKED_KINDS: readonly ProjectionKind[] = npmFilesSpecs().map((s) => s.kind);
/** The required inventory. The setup hook reads it one time from the source tree. */
let sourceProjections: readonly RequiredProjection[] = [];

function firstOfKind(kind: ProjectionKind): RequiredProjection {
  const found = sourceProjections.find((p) => p.kind === kind);
  if (found === undefined) throw new Error(`no source projection enumerated for kind '${kind}'`);
  return found;
}

/** Copies the unpacked package into a fresh scratch tree. */
function scratchCopy(label: string): string {
  const dest = path.join(workDir, `scratch-${label}`, 'package');
  rmrf(path.dirname(dest));
  fs.cpSync(pristinePackageDir, dest, { recursive: true });
  return dest;
}

/**
 * Reads the packed tree from disk and checks it against the source inventory from the setup hook.
 * It makes the comparison of `verifyPackedContainment` without a new walk of the source tree in
 * each loop pass. The two reads stay independent. The helper reads the packed side after each
 * mutation. The setup hook read the source side before any mutation. Each test that uses this
 * helper also calls `assertPackedContainment`, which reads both sides itself.
 */
function verifyPackedAgainstSource(packageDir: string): ContainmentResult {
  const packed = readPackedProjectionLayer(packageDir);
  return verifyContainment({ required: sourceProjections, layers: [packed.layer] });
}

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-t29-packed-'));
  const tarball = await runNpmPack(REPO_ROOT, path.join(workDir, 'tgz'));
  pristinePackageDir = await extractTarball(tarball, path.join(workDir, 'pristine'));
  sourceProjections = enumerateProjections(REPO_ROOT, npmFilesSpecs()).projections;
}, PACK_HOOK_TIMEOUT_MS);

afterAll(() => {
  if (workDir !== '') rmrf(workDir);
});

describe('projection containment against packed bytes', () => {
  /**
   * Guards against a vacuous proof. The archive must carry more than 40 projections, more files
   * than projections, and at least one projection of each packed kind.
   */
  it('unpacks a real npm pack tarball carrying real projection bytes', () => {
    const packed = readPackedProjectionLayer(pristinePackageDir);
    expect(packed.paths.length).toBeGreaterThan(40);
    expect(packed.totalFiles).toBeGreaterThan(packed.paths.length);
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
   * The source inventory does not depend on the artifact. The test deletes one packed agent, so
   * the packed side shrinks by one. A new read of the source tree keeps its length and still holds
   * the deleted path. This independence lets each assertion in the suite fail.
   */
  it('the inventory authority is independent of the packed artifact', () => {
    const scratch = scratchCopy('independence');
    const before = readPackedProjectionLayer(scratch);
    const victim = firstOfKind('agent');

    fs.rmSync(path.join(scratch, victim.path));

    const after = readPackedProjectionLayer(scratch);
    expect(after.paths.length).toBe(before.paths.length - 1);
    expect(after.paths).not.toContain(victim.path);
    const reread = enumerateProjections(REPO_ROOT, npmFilesSpecs()).projections;
    expect(reread.length).toBe(sourceProjections.length);
    expect(reread.some((p) => p.path === victim.path)).toBe(true);
  });
});

describe('seeded packed-artifact defects', () => {
  /**
   * BLOCKING CLAIM: a projection that is absent from the shipped tarball must fail verification,
   * for each `npm-files` projection kind on its own.
   *
   * @kill-seam: the packed bytes read off disk by readPackedProjectionLayer — delete one projection file from the unpacked tarball and the source-tree inventory still requires it, so verification must report `missing`
   *
   * NEGATIVE TWIN: the same scratch tree passes again after the test restores the file. That
   * attributes the failure to the deletion, not to the fixture setup. Last,
   * `assertPackedContainment` must throw a `PackedContainmentError` that names the path and
   * `missing`.
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

      fs.writeFileSync(abs, saved, 'utf8');
      const restored = verifyPackedAgainstSource(scratch);
      expect(restored.ok, `restoring packed ${kind} '${victim.path}' did not return to green`).toBe(true);
    }

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
   * BLOCKING CLAIM: a projection with rewritten bytes in the shipped tarball must fail
   * verification. The path is the same and the content differs, so only a content digest finds it.
   * The test first checks that the tampered text has a different digest.
   *
   * @kill-seam: the content digest of the packed bytes versus the authored source digest — rewrite one packed projection file in place and verification must report `content-mismatch`, not merely `missing`
   *
   * NEGATIVE TWIN: a rewrite of the same content with CRLF line endings must pass, because the
   * digest changes CRLF to LF first. A failure there means that the fixture detects any write, not
   * a content change. Last, `assertPackedContainment` must throw a `PackedContainmentError` that
   * names the path and `content-mismatch`.
   */
  it('PackedContainment_RewrittenProjectionBytes_FailsVerification', () => {
    const scratch = scratchCopy('rewritten');

    for (const kind of PACKED_KINDS) {
      const victim = firstOfKind(kind);
      const abs = path.join(scratch, victim.path);
      const saved = fs.readFileSync(abs, 'utf8');

      const tampered = `${saved}\nT29-TAMPERED-PROJECTION-BYTES\n`;
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

      fs.writeFileSync(abs, saved.replace(/\r?\n/g, '\r\n'), 'utf8');
      const crlf = verifyPackedAgainstSource(scratch);
      expect(crlf.ok, `a CRLF-only rewrite of ${kind} '${victim.path}' must not fail containment`).toBe(true);

      fs.writeFileSync(abs, saved, 'utf8');
    }

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
   * A tarball that holds a projection the source tree does not require must fail. A proof from one
   * shared map cannot find this case, because the extra file becomes an extra inventory entry.
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
   * An empty packed tree and an absent directory must throw. A result of zero required projections
   * and zero violations proves nothing.
   */
  it('an empty packed tree fails loudly instead of proving nothing', () => {
    const empty = path.join(workDir, 'empty-package');
    rmrf(empty);
    fs.mkdirSync(empty, { recursive: true });
    expect(() => readPackedProjectionLayer(empty)).toThrow(/ZERO projection files/);
    expect(() =>
      verifyPackedContainment({ repoRoot: REPO_ROOT, packageDir: path.join(workDir, 'never-unpacked') }),
    ).toThrow(/missing or not a directory/);
  });
});
