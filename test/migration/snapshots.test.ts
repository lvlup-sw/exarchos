/**
 * Task 025 — Skill render snapshot tests.
 *
 * Captures the full contents of every generated `SKILL.md` render as a
 * vitest snapshot so any renderer change that affects output becomes
 * visible as a PR diff. Post-collapse the tree has two render surfaces:
 *
 *   - Procedural skills render ONCE to `skills/standard/<skill>/SKILL.md`
 *     (runtime-neutral) — snapshotted once under the `standard` group.
 *   - Orchestration skills (`ideate`, `delegate`, `refactor`) render
 *     per-runtime to `skills/<runtime>/<skill>/SKILL.md` — snapshotted
 *     once per runtime.
 *
 * Two tests:
 *
 *   1. `Snapshots_AllSkillsAllRuntimes_MatchBaseline` — walks the
 *      committed tree and calls `toMatchSnapshot()` once per SKILL.md,
 *      grouped by render dir (`standard` + each runtime) via `describe()`
 *      blocks for readability.
 *
 *   2. `Snapshots_RegenerationPath_Deterministic` — rebuilds the entire
 *      skills tree into a fresh tmpdir via `buildAllSkills()` and
 *      asserts byte-for-byte equality against the committed
 *      `skills/<dir>/<skill>/SKILL.md` files (standard + every runtime).
 *      This catches non-determinism in the renderer that would otherwise
 *      slip past snapshot matching (snapshots only flag drift relative to
 *      a prior run, not drift between two runs of the same source).
 *
 * On the very first run the snapshot baseline does not yet exist, so the
 * top-level `Snapshots_BaselineFile_Present` check fails (and `-u` must
 * be used to seed). After seeding, CI runs without `-u` and any output
 * drift surfaces as a failing snapshot assertion in the PR diff.
 *
 * Excludes `skills/test-fixtures/` and `skills/trigger-tests/` — those
 * are validator fixtures, not deployable skills, and their contents are
 * covered by dedicated validator tests.
 *
 * Implements: Testing Strategy > Snapshot tests.
 */

import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAllSkills } from '../../src/install/build-skills.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');
const SKILLS_SRC_DIR = join(REPO_ROOT, 'content');
const RUNTIMES_DIR = join(REPO_ROOT, 'runtimes');
const SNAPSHOTS_DIR = join(__dirname, '__snapshots__');
const SNAPSHOT_FILE = join(SNAPSHOTS_DIR, 'snapshots.test.ts.snap');

const RUNTIME_NAMES = [
  'claude',
  'codex',
  'copilot',
  'cursor',
  'generic',
  'opencode',
] as const;

// Render directories under `skills/` that hold generated SKILL.md files.
// Procedural skills collapse to a single `standard/` render; orchestration
// skills render per-runtime. Snapshots cover both surfaces so drift in
// either is visible in the PR diff. `standard` is listed first so its group
// sorts ahead of the per-runtime groups in the snapshot file.
const RENDER_DIRS = ['standard', ...RUNTIME_NAMES] as const;

/** Subdirectories under `skills/` that are NOT runtime outputs. */
const NON_RUNTIME_DIRS = new Set(['test-fixtures', 'trigger-tests']);

/**
 * Return every `SKILL.md` path (absolute) under `skills/<runtime>/` as
 * `{runtime, skill, absolutePath, relativePath}` tuples, sorted by
 * `(runtime, skill)` so snapshot ordering is deterministic across
 * filesystems. `relativePath` is relative to `REPO_ROOT` and used as
 * the snapshot key so the snapshot file is self-describing.
 */
function listGeneratedSkillFiles(): Array<{
  runtime: string;
  skill: string;
  absolutePath: string;
  relativePath: string;
}> {
  const out: Array<{
    runtime: string;
    skill: string;
    absolutePath: string;
    relativePath: string;
  }> = [];

  if (!existsSync(SKILLS_DIR)) return out;

  for (const runtime of readdirSync(SKILLS_DIR).sort()) {
    if (NON_RUNTIME_DIRS.has(runtime)) continue;
    const runtimeDir = join(SKILLS_DIR, runtime);
    let st;
    try {
      st = statSync(runtimeDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    for (const skill of readdirSync(runtimeDir).sort()) {
      const skillDir = join(runtimeDir, skill);
      let skillStat;
      try {
        skillStat = statSync(skillDir);
      } catch {
        continue;
      }
      if (!skillStat.isDirectory()) continue;

      const skillFile = join(skillDir, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      out.push({
        runtime,
        skill,
        absolutePath: skillFile,
        relativePath: relative(REPO_ROOT, skillFile).split(/[\\/]/).join('/'),
      });
    }
  }

  return out;
}

/**
 * Walk `root` and return a map of relative-path -> file contents for
 * every regular file under it. Used by the deterministic-regeneration
 * test to compare two trees byte-for-byte. Paths are returned relative
 * to `root` with forward slashes so the comparison is platform-stable.
 */
function snapshotTreeContents(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!existsSync(root)) return out;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        const key = relative(root, full).split(/[\\/]/).join('/');
        out.set(key, readFileSync(full));
      }
    }
  };

  walk(root);
  return out;
}

// -----------------------------------------------------------------------------
// Pre-check: snapshot baseline must exist.
// -----------------------------------------------------------------------------
//
// Vitest auto-creates snapshot files on first run, which means
// `toMatchSnapshot()` never fails on a cold cache. That would break
// the RED → GREEN transition for this task: the tests would pass
// before the baseline was ever committed, and a subsequent drift
// would be invisible because there was never a real baseline to
// compare against.
//
// This describe block exists solely to force a true failure until
// the snapshot file has been seeded (`vitest run -u`) and committed.
// Once committed, the check passes on every subsequent run.
describe('task 025 — snapshot baseline presence', () => {
  it('Snapshots_BaselineFile_Present', () => {
    expect(
      existsSync(SNAPSHOT_FILE),
      `snapshot baseline ${SNAPSHOT_FILE} is missing — ` +
        `run \`npm run test:run -- snapshots -u\` to seed it, ` +
        `then commit the __snapshots__/ directory.`,
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Test 1: Snapshots_AllSkillsAllRuntimes_MatchBaseline
// -----------------------------------------------------------------------------

describe('task 025 — per-runtime snapshot baselines', () => {
  const allFiles = listGeneratedSkillFiles();

  // Group files by runtime so the snapshot output is easy to scan and
  // per-runtime drift is visually isolated in a failing PR diff.
  const byRuntime = new Map<string, typeof allFiles>();
  for (const rt of RENDER_DIRS) byRuntime.set(rt, []);
  for (const f of allFiles) {
    if (!byRuntime.has(f.runtime)) byRuntime.set(f.runtime, []);
    byRuntime.get(f.runtime)!.push(f);
  }

  it('Snapshots_AllSkillsAllRuntimes_SetCardinality', () => {
    // Guard against silent drift in the total count. History: the plan
    // assumed 16 × 6 = 96; the initial migration landed 13 × 6 = 78; #1010
    // added prune + oneshot (15 × 6 = 90); v2.8.0 added discovery (16 × 6);
    // v2.9.0 added merge-orchestrator (17 × 6 = 102); v2.10.0 added
    // authoring-invariants (18 × 6 = 108); v2.11.0 added mutation-adequacy
    // (19 × 6 = 114), then collapsed spec-review + quality-review into one
    // `review` (18 × 6 = 108).
    //
    // The harness conform-and-shrink collapse then split rendering by class:
    // 16 procedural skills render ONCE to `skills/standard/` (the
    // `workflow-state` skill split into `rehydrate` + `checkpoint`), and 3
    // orchestration skills render per-runtime (3 × 6 = 18). 16 + 18 = 34.
    expect(allFiles.length).toBe(34);
  });

  for (const runtime of RENDER_DIRS) {
    const runtimeFiles = byRuntime.get(runtime) ?? [];

    describe(`render dir: ${runtime}`, () => {
      for (const file of runtimeFiles) {
        it(`Snapshots_AllSkillsAllRuntimes_MatchBaseline: ${file.relativePath}`, () => {
          const contents = readFileSync(file.absolutePath, 'utf8');
          // Use the relative path as the snapshot name so the snapshot
          // file is self-describing and diffs cite the exact source.
          expect(contents).toMatchSnapshot(file.relativePath);
        });
      }
    });
  }
});

// -----------------------------------------------------------------------------
// Test 2: Snapshots_RegenerationPath_Deterministic
// -----------------------------------------------------------------------------

describe('task 025 — deterministic regeneration', () => {
  it('Snapshots_RegenerationPath_Deterministic', () => {
    // Rebuild the entire skills tree into a throwaway tmpdir and
    // assert that every render-dir subtree (`standard/` plus each
    // runtime) is byte-identical to the committed `skills/<dir>/`
    // subtree. This catches non-determinism in the renderer (e.g. a
    // Map iteration order leak or a `Date.now()` reference) that
    // snapshot matching alone would miss after the first `-u` seed.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'exarchos-snap-det-'));
    try {
      buildAllSkills({
        srcDir: SKILLS_SRC_DIR,
        outDir: tmpRoot,
        runtimesDir: RUNTIMES_DIR,
      });

      for (const runtime of RENDER_DIRS) {
        const committed = snapshotTreeContents(join(SKILLS_DIR, runtime));
        const rebuilt = snapshotTreeContents(join(tmpRoot, runtime));

        // Key sets must match exactly — any missing or extra file is a
        // regression.
        const committedKeys = [...committed.keys()].sort();
        const rebuiltKeys = [...rebuilt.keys()].sort();
        expect(
          rebuiltKeys,
          `runtime ${runtime}: file set differs from committed tree`,
        ).toEqual(committedKeys);

        // Byte-for-byte comparison of every file.
        for (const key of committedKeys) {
          const a = committed.get(key)!;
          const b = rebuilt.get(key)!;
          if (!a.equals(b)) {
            // Surface a readable diff instead of a raw buffer mismatch
            // so CI failures are debuggable without rerunning locally.
            expect(
              b.toString('utf8'),
              `runtime ${runtime}, file ${key}: content differs from committed tree`,
            ).toBe(a.toString('utf8'));
          }
        }
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
