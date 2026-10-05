/**
 * Render tests for the ideate skill, the canary of the single-source skill renderer.
 *
 * 1. The render of `claude/ideate/SKILL.md` is byte-identical to the baseline in
 *    `__fixtures__/ideate-baseline.md`. This is the canary assertion for the renderer.
 * 2. The generic variant holds no Claude-native text from the `{{MCP_PREFIX}}`,
 *    `{{COMMAND_PREFIX}}` or `{{CHAIN}}` substitution. It uses the values of
 *    `content/harness/runtimes/generic.yaml`.
 * 3. The frontmatter is identical in the six runtime variants. Only the body differs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildAllSkills } from '../../src/install/build-skills.js';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'content');
const RUNTIMES_DIR = join(REPO_ROOT, 'content/harness/runtimes');
const BASELINE_PATH = join(
  REPO_ROOT,
  'tests/migration/__fixtures__/ideate-baseline.md',
);

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ideate-canary-'));
  tempDirs.push(dir);
  return dir;
}

function buildIntoTemp(): string {
  const outDir = makeTempDir();
  buildAllSkills({ srcDir: SRC_DIR, outDir, runtimesDir: RUNTIMES_DIR });
  return outDir;
}

function readBaselineFixture(): string {
  return readFileSync(BASELINE_PATH, 'utf8');
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

describe('task 015 — ideate canary migration', () => {
  /**
   * The baseline is a committed copy of the render. An intended change of the skill source or of
   * the renderer must also update the baseline. `toBe` on the two strings is a byte-exact
   * comparison, and it marks the first difference.
   */
  it('Migration_Ideate_ClaudeVariantByteIdenticalToCurrent', () => {
    expect(existsSync(BASELINE_PATH)).toBe(true);
    const baseline = readBaselineFixture();

    const outDir = buildIntoTemp();
    const claudeOut = join(outDir, 'claude', 'ideate', 'SKILL.md');
    expect(existsSync(claudeOut)).toBe(true);

    const rendered = readFileSync(claudeOut, 'utf8');
    expect(rendered).toBe(baseline);
  });

  /**
   * The generic map sets the MCP prefix to `mcp__exarchos__`, so the Claude plugin prefix must be
   * absent and the generic prefix present. `COMMAND_PREFIX` is empty in `generic.yaml`, so
   * `/exarchos:` must be absent. `CHAIN` renders as a prose directive, so `Skill({` must be absent.
   */
  it('Migration_Ideate_GenericVariant_NoClaudeSpecificSyntax', () => {
    const outDir = buildIntoTemp();
    const genericOut = join(outDir, 'generic', 'ideate', 'SKILL.md');
    expect(existsSync(genericOut)).toBe(true);
    const rendered = readFileSync(genericOut, 'utf8');

    expect(rendered).not.toContain('mcp__plugin_exarchos_exarchos__');

    expect(rendered).not.toContain('/exarchos:');

    expect(rendered).not.toContain('Skill({');

    expect(rendered).toContain('mcp__exarchos__');
  });

  /**
   * The frontmatter is the block from the first `---` line to the second one. Each variant must
   * equal the first variant. The `description:` check rejects a comparison of empty strings.
   */
  it('Migration_Ideate_AllSixVariantsHaveIdenticalDescriptionFrontmatter', () => {
    const outDir = buildIntoTemp();
    const runtimeNames = [
      'generic',
      'claude',
      'codex',
      'opencode',
      'copilot',
      'cursor',
    ];

    const extractFrontmatter = (content: string): string => {
      const lines = content.split('\n');
      expect(lines[0]).toBe('---');
      const closingIdx = lines.indexOf('---', 1);
      expect(closingIdx).toBeGreaterThan(0);
      return lines.slice(0, closingIdx + 1).join('\n');
    };

    const frontmatters = runtimeNames.map((rt) => {
      const p = join(outDir, rt, 'ideate', 'SKILL.md');
      expect(existsSync(p)).toBe(true);
      return extractFrontmatter(readFileSync(p, 'utf8'));
    });

    for (let i = 1; i < frontmatters.length; i++) {
      expect(frontmatters[i]).toBe(frontmatters[0]);
    }

    expect(frontmatters[0]).toMatch(/description:/);
  });
});
