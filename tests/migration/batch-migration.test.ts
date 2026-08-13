/**
 * Task 016 — Batch migration tests for the simple skills.
 *
 * After the canary proof on brainstorming/ideate (task 015), this wave
 * migrated the remaining simple skills into `content/<name>/` sources.
 * The renderer must produce byte-identical renders for every one of them,
 * and must never leak Claude-specific syntax into the runtime-neutral
 * fallback variant.
 *
 * Post-collapse the render PATH depends on the skill's class:
 *
 *   - Procedural skills render ONCE to `skills/standard/<name>/SKILL.md`
 *     (runtime-neutral). Of this batch, `refactor` is the only exception.
 *   - Orchestration skills render per-runtime to
 *     `skills/<runtime>/<name>/SKILL.md`; `refactor` is orchestration.
 *
 * The `workflow-state` skill split into `rehydrate` + `checkpoint`;
 * `implementation-planning` → `plan`; `synthesis` → `synthesize`. The
 * baseline fixtures are named after the canonical verbs.
 *
 * Three assertions cover the batch wave:
 *
 *   1. `BatchMigration_AllTenSkills_ClaudeVariantByteIdenticalToBaseline` —
 *      for every migrated skill, the render at its class-resolved path
 *      (procedural → `skills/standard/<name>/`, orchestration →
 *      `skills/claude/<name>/`) MUST be byte-identical to the captured
 *      baseline in `__fixtures__/batch-baselines/<name>.md`. If this
 *      assertion fails for any skill, the placeholder insertion for that
 *      source is wrong — fix the source, not the renderer.
 *
 *   2. `BatchMigration_AllTenSkills_GenericVariantNoClaudePrefixes` —
 *      the runtime-neutral variant (procedural → `standard`,
 *      orchestration → `generic`) must NOT contain any Claude-native
 *      substitution artifacts: `mcp__plugin_exarchos_exarchos__`,
 *      `/exarchos:`, or `Skill({`.
 *
 *   3. `BatchMigration_NoUnresolvedPlaceholders_InAnyVariant` —
 *      scan every generated `SKILL.md` render (standard + per-runtime)
 *      for residual `{{...}}` tokens. Zero residuals allowed.
 *
 * Implements: DR-1, DR-8.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildAllSkills } from '../../src/install/build-skills.js';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// The simple skills migrated by task 016, keyed by canonical verb and
// classified so the test can resolve each render path. Brainstorming/ideate
// (the canary, task 015) has its own test file. `refactor` is the only
// orchestration skill in this batch; the rest render once to `standard`.
// `workflow-state` split into `rehydrate` + `checkpoint`.
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

// Render directories under the build output: procedural skills collapse to
// `standard/`, orchestration skills render per-runtime. Used by the
// no-unresolved-placeholders scan to cover every rendered SKILL.md.
const RENDER_DIRS = ['standard', ...RUNTIME_NAMES];

/**
 * Resolve the byte-identical render path for a skill: procedural skills
 * render once to `skills/standard/<skill>/`, orchestration skills render
 * per-runtime — `claude` is the reference variant compared to the baseline.
 */
function baselineRenderPath(outDir: string, skill: string, skillClass: SkillClass): string {
  const tree = skillClass === 'procedural' ? 'standard' : 'claude';
  return join(outDir, tree, skill, 'SKILL.md');
}

/**
 * Resolve the runtime-neutral variant path: procedural skills expose only
 * the `standard` render; orchestration skills expose a `generic` fallback.
 * Both must be free of Claude-native substitution artifacts.
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

/**
 * Walk a directory tree and return every file path (absolute) whose
 * basename is `SKILL.md`. Used by the no-unresolved-placeholders scan.
 */
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

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('task 016 — batch migration of simple skills', () => {
  it('BatchMigration_AllTenSkills_ClaudeVariantByteIdenticalToBaseline', () => {
    const outDir = buildIntoTemp();

    // Collect all mismatches before failing so a single run surfaces
    // every broken source at once, rather than one-at-a-time discovery.
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

    // If anything failed, assert on the first skill so vitest prints the
    // offending diff with its built-in string comparator.
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

      // None of these Claude-specific artifacts may leak into the
      // runtime-neutral variant via missed placeholder substitution.
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

  it('BatchMigration_NoUnresolvedPlaceholders_InAnyVariant', () => {
    const outDir = buildIntoTemp();

    // Walk every rendered `SKILL.md` produced this run — the collapsed
    // `standard/` tree plus each per-runtime tree — and assert that no
    // `{{TOKEN}}` residuals survived rendering.
    const residualPattern = /\{\{\w+/;
    const allFiles: string[] = [];
    for (const dir of RENDER_DIRS) {
      allFiles.push(...findAllSkillMdFiles(join(outDir, dir)));
    }

    // Sanity: the full render tree is 16 procedural (standard) + 3
    // orchestration × 6 runtimes = 34 files. Guard the lower bound so a
    // renderer that silently stops emitting a tree is caught.
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
