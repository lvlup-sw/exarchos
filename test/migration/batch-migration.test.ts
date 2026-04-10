/**
 * Task 016 — Batch migration tests for the 11 simple skills.
 *
 * After the canary proof on brainstorming (task 015), this wave migrates
 * the remaining simple skills from the legacy top-level `skills/<name>/`
 * tree into the `skills-src/<name>/` sources. The renderer must produce
 * byte-identical Claude variants for every one of them, and must never
 * leak Claude-specific syntax into the generic variants.
 *
 * Three assertions cover the batch wave:
 *
 *   1. `BatchMigration_AllElevenSkills_ClaudeVariantByteIdenticalToBaseline` —
 *      for every migrated skill, the rendered
 *      `skills/claude/<name>/SKILL.md` MUST be byte-identical to the
 *      captured baseline in `__fixtures__/batch-baselines/<name>.md`.
 *      If this assertion fails for any skill, the placeholder insertion
 *      for that source is wrong — fix the source, not the renderer.
 *
 *   2. `BatchMigration_AllElevenSkills_GenericVariantNoClaudePrefixes` —
 *      the generic fallback variant must NOT contain any Claude-native
 *      substitution artifacts: `mcp__plugin_exarchos_exarchos__`,
 *      `/exarchos:`, or `Skill({`.
 *
 *   3. `BatchMigration_NoUnresolvedPlaceholders_InAnyVariant` —
 *      scan every generated `skills/<runtime>/<name>/SKILL.md` file for
 *      residual `{{...}}` tokens. Zero residuals allowed.
 *
 * Implements: DR-1, DR-8.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildAllSkills } from '../../src/build-skills.js';
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
const SRC_DIR = join(REPO_ROOT, 'skills-src');
const RUNTIMES_DIR = join(REPO_ROOT, 'runtimes');
const BASELINE_DIR = join(
  REPO_ROOT,
  'test',
  'migration',
  '__fixtures__',
  'batch-baselines',
);

// The 11 simple skills migrated by task 016. Brainstorming (the canary,
// task 015) is intentionally NOT in this list — it has its own test file.
// `rehydrate` and `tdd` from the original plan are commands, not skills.
const BATCH_SKILLS = [
  'cleanup',
  'debug',
  'dogfood',
  'git-worktrees',
  'implementation-planning',
  'quality-review',
  'refactor',
  'shepherd',
  'spec-review',
  'synthesis',
  'workflow-state',
];

const RUNTIME_NAMES = [
  'generic',
  'claude',
  'codex',
  'opencode',
  'copilot',
  'cursor',
];

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

describe('task 016 — batch migration of 11 simple skills', () => {
  it('BatchMigration_AllElevenSkills_ClaudeVariantByteIdenticalToBaseline', () => {
    const outDir = buildIntoTemp();

    // Collect all mismatches before failing so a single run surfaces
    // every broken source at once, rather than one-at-a-time discovery.
    const failures: string[] = [];
    for (const skill of BATCH_SKILLS) {
      const baselinePath = join(BASELINE_DIR, `${skill}.md`);
      expect(existsSync(baselinePath)).toBe(true);
      const baseline = readFileSync(baselinePath, 'utf8');

      const claudeOut = join(outDir, 'claude', skill, 'SKILL.md');
      if (!existsSync(claudeOut)) {
        failures.push(`${skill}: claude variant missing at ${claudeOut}`);
        continue;
      }
      const rendered = readFileSync(claudeOut, 'utf8');
      if (rendered !== baseline) {
        failures.push(`${skill}: claude variant differs from baseline`);
      }
    }

    // If anything failed, assert on the first skill so vitest prints the
    // offending diff with its built-in string comparator.
    if (failures.length > 0) {
      const firstBroken = failures[0].split(':')[0];
      const baseline = readFileSync(join(BASELINE_DIR, `${firstBroken}.md`), 'utf8');
      const rendered = readFileSync(
        join(outDir, 'claude', firstBroken, 'SKILL.md'),
        'utf8',
      );
      expect(rendered, `failures: ${failures.join('; ')}`).toBe(baseline);
    }
  });

  it('BatchMigration_AllElevenSkills_GenericVariantNoClaudePrefixes', () => {
    const outDir = buildIntoTemp();

    for (const skill of BATCH_SKILLS) {
      const genericOut = join(outDir, 'generic', skill, 'SKILL.md');
      expect(existsSync(genericOut)).toBe(true);
      const rendered = readFileSync(genericOut, 'utf8');

      // None of these Claude-specific artifacts may leak into the generic
      // variant via missed placeholder substitution.
      expect(
        rendered,
        `${skill}: generic variant contains Claude plugin MCP prefix`,
      ).not.toContain('mcp__plugin_exarchos_exarchos__');

      expect(
        rendered,
        `${skill}: generic variant contains /exarchos: slash command`,
      ).not.toContain('/exarchos:');

      expect(
        rendered,
        `${skill}: generic variant contains Skill({ chain syntax`,
      ).not.toContain('Skill({');
    }
  });

  it('BatchMigration_NoUnresolvedPlaceholders_InAnyVariant', () => {
    const outDir = buildIntoTemp();

    // Walk every `skills/<runtime>/<name>/SKILL.md` produced this run
    // and assert that no `{{TOKEN}}` residuals survived rendering.
    const residualPattern = /\{\{\w+/;
    const allFiles: string[] = [];
    for (const rt of RUNTIME_NAMES) {
      allFiles.push(...findAllSkillMdFiles(join(outDir, rt)));
    }

    // Sanity: there must be at least 11 batch skills × 6 runtimes = 66
    // files (plus the brainstorming canary variants, so >= 72 total).
    expect(allFiles.length).toBeGreaterThanOrEqual(72);

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
