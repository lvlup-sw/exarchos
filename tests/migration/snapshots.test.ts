/**
 * Snapshot tests for the rendered `SKILL.md` files under `rendered/skills`.
 *
 * A procedural skill renders one time, to `standard/<skill>/SKILL.md`. An orchestration skill
 * (`ideate`, `delegate`, `refactor`) renders one time for each runtime, to
 * `<runtime>/<skill>/SKILL.md`. Each rendered file has one snapshot, so a renderer change that
 * changes the output shows as a snapshot diff.
 *
 * A second test builds the tree again and compares it with the committed tree, byte for byte. The
 * snapshot walk skips a directory with the name `test-fixtures` or `trigger-tests`, because such a
 * directory holds no deployable skill.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAllSkills } from '../../src/install/build-skills.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SKILLS_DIR = join(REPO_ROOT, 'rendered/skills');
const SKILLS_SRC_DIR = join(REPO_ROOT, 'content');
const RUNTIMES_DIR = join(REPO_ROOT, 'content/harness/runtimes');
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

/**
 * The directories under `rendered/skills` that hold rendered `SKILL.md` files: `standard`, then one
 * for each runtime.
 */
const RENDER_DIRS = ['standard', ...RUNTIME_NAMES] as const;

/** Directory names under `rendered/skills` that are not render output. */
const NON_RUNTIME_DIRS = new Set(['test-fixtures', 'trigger-tests']);

/**
 * Returns each rendered `SKILL.md` file, sorted by render directory and then by skill, so the order
 * does not depend on the filesystem. `relativePath` is relative to the repo root, with forward
 * slashes. It is the snapshot name.
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
 * Returns the content of each regular file under `root`, keyed by its path relative to `root` with
 * forward slashes. The regeneration test compares two trees with it.
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

/**
 * Vitest writes a snapshot file that does not exist, so `toMatchSnapshot()` passes when there is no
 * baseline. This check fails until the snapshot file exists. An operator seeds the file with
 * `vitest run -u` and commits it.
 */
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

/** One `describe` group for each render directory, so a failure shows which directory drifted. */
describe('task 025 — per-runtime snapshot baselines', () => {
  const allFiles = listGeneratedSkillFiles();

  const byRuntime = new Map<string, typeof allFiles>();
  for (const rt of RENDER_DIRS) byRuntime.set(rt, []);
  for (const f of allFiles) {
    if (!byRuntime.has(f.runtime)) byRuntime.set(f.runtime, []);
    byRuntime.get(f.runtime)!.push(f);
  }

  /**
   * Guards the total count. 16 procedural skills render one time to `standard`, and 3
   * orchestration skills render for each of 6 runtimes: 16 + 18 = 34.
   */
  it('Snapshots_AllSkillsAllRuntimes_SetCardinality', () => {
    expect(allFiles.length).toBe(34);
  });

  for (const runtime of RENDER_DIRS) {
    const runtimeFiles = byRuntime.get(runtime) ?? [];

    describe(`render dir: ${runtime}`, () => {
      for (const file of runtimeFiles) {
        it(`Snapshots_AllSkillsAllRuntimes_MatchBaseline: ${file.relativePath}`, () => {
          const contents = readFileSync(file.absolutePath, 'utf8');
          expect(contents).toMatchSnapshot(file.relativePath);
        });
      }
    });
  }
});

describe('task 025 — deterministic regeneration', () => {
  /**
   * Builds the full skills tree into a temp directory. Each render directory must hold the same
   * files as the committed tree, with the same bytes. The snapshot tests read only the committed
   * files, so they cannot show a renderer that is not deterministic. On a byte mismatch, the test
   * compares the UTF-8 text, so the failure shows a readable diff.
   */
  it('Snapshots_RegenerationPath_Deterministic', () => {
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

        const committedKeys = [...committed.keys()].sort();
        const rebuiltKeys = [...rebuilt.keys()].sort();
        expect(
          rebuiltKeys,
          `runtime ${runtime}: file set differs from committed tree`,
        ).toEqual(committedKeys);

        for (const key of committedKeys) {
          const a = committed.get(key)!;
          const b = rebuilt.get(key)!;
          if (!a.equals(b)) {
            expect(
              b.toString('utf8'),
              `runtime ${runtime}, file ${key}: content differs from committed tree`,
            ).toBe(a.toString('utf8'));
          }
        }
      }
    } finally {
      rmrf(tmpRoot);
    }
  });
});
