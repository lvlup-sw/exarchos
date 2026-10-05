/**
 * Render tests for the batch of simple skills that have their source under `content/`.
 *
 * The render path depends on the class of the skill:
 * - A procedural skill renders once, to the runtime-neutral `standard/<name>/SKILL.md`.
 * - An orchestration skill renders for each runtime, to `<runtime>/<name>/SKILL.md`.
 *
 * The three tests assert:
 * 1. The render at the class path is byte-identical to the baseline in
 *    `__fixtures__/batch-baselines/<name>.md`.
 * 2. The runtime-neutral variant holds no Claude-native text: `mcp__plugin_exarchos_exarchos__`,
 *    `/exarchos:` or `Skill({`.
 * 3. No rendered `SKILL.md` holds an unresolved `{{...}}` token.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildAllSkills } from '../../src/install/build-skills.js';
import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'content');
const RUNTIMES_DIR = join(REPO_ROOT, 'content/harness/runtimes');
const BASELINE_DIR = join(
  REPO_ROOT,
  'tests/migration/__fixtures__/batch-baselines',
);

type SkillClass = 'procedural' | 'orchestration';

/**
 * The skills of the batch by canonical verb, with the class that gives each render path. `refactor`
 * is the only orchestration skill. The ideate skill has its own test file.
 */
const BATCH_SKILLS: ReadonlyArray<{ skill: string; skillClass: SkillClass }> = [
  { skill: 'cleanup', skillClass: 'procedural' },
  { skill: 'debug', skillClass: 'procedural' },
  { skill: 'dogfood', skillClass: 'procedural' },
  { skill: 'git-worktrees', skillClass: 'procedural' },
  { skill: 'plan', skillClass: 'procedural' },
  { skill: 'refactor', skillClass: 'orchestration' },
  { skill: 'review', skillClass: 'procedural' },
  { skill: 'shepherd', skillClass: 'procedural' },
  { skill: 'synthesize', skillClass: 'procedural' },
  { skill: 'rehydrate', skillClass: 'procedural' },
  { skill: 'checkpoint', skillClass: 'procedural' },
];

const RUNTIME_NAMES = [
  'generic',
  'claude',
  'codex',
  'opencode',
  'copilot',
  'cursor',
];

/** The render directories under the build output. The placeholder scan reads each one. */
const RENDER_DIRS = ['standard', ...RUNTIME_NAMES];

/**
 * Gives the path of the render that the test compares with the baseline. A procedural skill renders
 * once under `standard`. For an orchestration skill, `claude` is the reference variant.
 */
function baselineRenderPath(outDir: string, skill: string, skillClass: SkillClass): string {
  const tree = skillClass === 'procedural' ? 'standard' : 'claude';
  return join(outDir, tree, skill, 'SKILL.md');
}

/**
 * Gives the path of the runtime-neutral variant: `standard` for a procedural skill and `generic`
 * for an orchestration skill.
 */
function neutralRenderPath(outDir: string, skill: string, skillClass: SkillClass): string {
  const tree = skillClass === 'procedural' ? 'standard' : 'generic';
  return join(outDir, tree, skill, 'SKILL.md');
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'batch-migration-'));
  tempDirs.push(dir);
  return dir;
}

function buildIntoTemp(): string {
  const outDir = makeTempDir();
  buildAllSkills({ srcDir: SRC_DIR, outDir, runtimesDir: RUNTIMES_DIR });
  return outDir;
}

/** Walks a directory tree and returns the absolute path of each file named `SKILL.md`. */
function findAllSkillMdFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && entry === 'SKILL.md') {
        out.push(full);
      }
    }
  }
  return out;
}

/** Removes each temp directory. The removal is best-effort, so the hook ignores a failure. */
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      rmrf(d);
    } catch {
    }
  }
});

describe('task 016 — batch migration of simple skills', () => {
  /**
   * The loop collects each mismatch, so one run shows each broken source. Then the test asserts on
   * the first broken skill, so vitest prints the string diff.
   */
  it('BatchMigration_AllTenSkills_ClaudeVariantByteIdenticalToBaseline', () => {
    const outDir = buildIntoTemp();

    const failures: string[] = [];
    for (const { skill, skillClass } of BATCH_SKILLS) {
      const baselinePath = join(BASELINE_DIR, `${skill}.md`);
      expect(existsSync(baselinePath)).toBe(true);
      const baseline = readFileSync(baselinePath, 'utf8');

      const renderOut = baselineRenderPath(outDir, skill, skillClass);
      if (!existsSync(renderOut)) {
        failures.push(`${skill}: ${skillClass} render missing at ${renderOut}`);
        continue;
      }
      const rendered = readFileSync(renderOut, 'utf8');
      if (rendered !== baseline) {
        failures.push(`${skill}: ${skillClass} render differs from baseline`);
      }
    }

    if (failures.length > 0) {
      const firstFailure = failures[0];
      if (firstFailure === undefined) throw new Error('unreachable: failures is non-empty here');
      const firstBroken = BATCH_SKILLS.find((s) => s.skill === firstFailure.split(':')[0]);
      if (!firstBroken) throw new Error(`no batch skill matches failure ${firstFailure}`);
      const baseline = readFileSync(
        join(BASELINE_DIR, `${firstBroken.skill}.md`),
        'utf8',
      );
      const rendered = readFileSync(
        baselineRenderPath(outDir, firstBroken.skill, firstBroken.skillClass),
        'utf8',
      );
      expect(rendered, `failures: ${failures.join('; ')}`).toBe(baseline);
    }
  });

  it('BatchMigration_AllTenSkills_GenericVariantNoClaudePrefixes', () => {
    const outDir = buildIntoTemp();

    for (const { skill, skillClass } of BATCH_SKILLS) {
      const neutralOut = neutralRenderPath(outDir, skill, skillClass);
      expect(existsSync(neutralOut)).toBe(true);
      const rendered = readFileSync(neutralOut, 'utf8');

      expect(
        rendered,
        `${skill}: neutral variant contains Claude plugin MCP prefix`,
      ).not.toContain('mcp__plugin_exarchos_exarchos__');

      expect(
        rendered,
        `${skill}: neutral variant contains /exarchos: slash command`,
      ).not.toContain('/exarchos:');

      expect(
        rendered,
        `${skill}: neutral variant contains Skill({ chain syntax`,
      ).not.toContain('Skill({');
    }
  });

  /**
   * The scan reads each rendered `SKILL.md` in the `standard` tree and in each runtime tree. The
   * full tree is 16 procedural renders plus 3 orchestration skills for 6 runtimes, which is 34
   * files. The lower bound catches a renderer that stops emitting a tree.
   */
  it('BatchMigration_NoUnresolvedPlaceholders_InAnyVariant', () => {
    const outDir = buildIntoTemp();

    const residualPattern = /\{\{\w+/;
    const allFiles: string[] = [];
    for (const dir of RENDER_DIRS) {
      allFiles.push(...findAllSkillMdFiles(join(outDir, dir)));
    }

    expect(allFiles.length).toBeGreaterThanOrEqual(34);

    const offenders: string[] = [];
    for (const file of allFiles) {
      const body = readFileSync(file, 'utf8');
      if (residualPattern.test(body)) {
        offenders.push(file);
      }
    }

    expect(
      offenders,
      `unresolved {{...}} tokens found in: ${offenders.join(', ')}`,
    ).toHaveLength(0);
  });
});
