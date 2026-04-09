/**
 * Task 015 — Canary migration tests for the brainstorming skill.
 *
 * This is the canary proof for the platform-agnostic skills migration
 * pipeline. Before the batch wave migrates 13 more skills, these three
 * tests verify the end-to-end flow on a single representative skill:
 *
 *   1. `Migration_Brainstorming_ClaudeVariantByteIdenticalToCurrent` —
 *      the critical canary assertion. The rendered
 *      `skills/claude/brainstorming/SKILL.md` MUST be byte-identical to
 *      the pre-migration `skills/brainstorming/SKILL.md` (captured in
 *      `__fixtures__/brainstorming-baseline.md`). If this assertion
 *      fails, the renderer is untrustworthy and the bug would propagate
 *      across all 16 skills in the batch wave.
 *
 *   2. `Migration_Brainstorming_GenericVariant_NoClaudeSpecificSyntax` —
 *      the generic fallback variant must NOT contain any Claude-native
 *      syntax that came from `{{MCP_PREFIX}}`, `{{COMMAND_PREFIX}}`, or
 *      `{{CHAIN}}` substitution. It must use the LCD values from
 *      `runtimes/generic.yaml`.
 *
 *   3. `Migration_Brainstorming_AllSixVariantsHaveIdenticalDescriptionFrontmatter` —
 *      the skill frontmatter must be identical across all 6 runtime
 *      variants; only the body differs via placeholder substitution.
 *
 * Implements: DR-1 (skills sourced once, rendered per runtime),
 *             DR-8 (brainstorming canary).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildAllSkills } from '../../src/build-skills.js';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'skills-src');
const RUNTIMES_DIR = join(REPO_ROOT, 'runtimes');
const BASELINE_PATH = join(
  REPO_ROOT,
  'test',
  'migration',
  '__fixtures__',
  'brainstorming-baseline.md',
);

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'brainstorming-canary-'));
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

describe('task 015 — brainstorming canary migration', () => {
  it('Migration_Brainstorming_ClaudeVariantByteIdenticalToCurrent', () => {
    // The canary assertion. If this fails, stop the migration wave and
    // investigate the renderer — do NOT propagate a broken pipeline.
    expect(existsSync(BASELINE_PATH)).toBe(true);
    const baseline = readBaselineFixture();

    const outDir = buildIntoTemp();
    const claudeOut = join(outDir, 'claude', 'brainstorming', 'SKILL.md');
    expect(existsSync(claudeOut)).toBe(true);

    const rendered = readFileSync(claudeOut, 'utf8');
    // Use strict string equality for a byte-exact diff. toBe() produces a
    // readable first-difference marker on failure, which is what we want
    // when iterating on placeholder substitution.
    expect(rendered).toBe(baseline);
  });

  it('Migration_Brainstorming_GenericVariant_NoClaudeSpecificSyntax', () => {
    const outDir = buildIntoTemp();
    const genericOut = join(outDir, 'generic', 'brainstorming', 'SKILL.md');
    expect(existsSync(genericOut)).toBe(true);
    const rendered = readFileSync(genericOut, 'utf8');

    // None of these Claude-specific artifacts may leak into the generic
    // variant. `mcp__plugin_exarchos_exarchos__` is the Claude plugin MCP
    // prefix; the generic map collapses it to `mcp__exarchos__`.
    expect(rendered).not.toContain('mcp__plugin_exarchos_exarchos__');

    // `COMMAND_PREFIX` is empty in generic.yaml, so `/exarchos:` should
    // never appear. Bare `exarchos_workflow` tool-name references (no
    // slash, no underscore prefix) are legitimate and not checked here.
    expect(rendered).not.toContain('/exarchos:');

    // The `CHAIN` placeholder in generic.yaml renders as a prose
    // `[Invoke the exarchos:... skill ...]` directive, so the literal
    // `Skill({` Claude syntax should never appear.
    expect(rendered).not.toContain('Skill({');

    // Positive assertion: the generic MCP prefix SHOULD appear at least
    // once (the skill documents state-management via `exarchos_workflow`
    // which is prefixed with the MCP namespace).
    expect(rendered).toContain('mcp__exarchos__');
  });

  it('Migration_Brainstorming_AllSixVariantsHaveIdenticalDescriptionFrontmatter', () => {
    const outDir = buildIntoTemp();
    const runtimeNames = [
      'generic',
      'claude',
      'codex',
      'opencode',
      'copilot',
      'cursor',
    ];

    // Extract the YAML frontmatter block (everything between the first
    // `---` and the second `---`, inclusive). The frontmatter must be
    // identical across all runtimes — only the body below it differs via
    // placeholder substitution.
    const extractFrontmatter = (content: string): string => {
      const lines = content.split('\n');
      expect(lines[0]).toBe('---');
      const closingIdx = lines.indexOf('---', 1);
      expect(closingIdx).toBeGreaterThan(0);
      return lines.slice(0, closingIdx + 1).join('\n');
    };

    const frontmatters = runtimeNames.map((rt) => {
      const p = join(outDir, rt, 'brainstorming', 'SKILL.md');
      expect(existsSync(p)).toBe(true);
      return extractFrontmatter(readFileSync(p, 'utf8'));
    });

    // Every frontmatter should equal the first one — the description,
    // metadata, and all frontmatter fields must be runtime-invariant.
    for (let i = 1; i < frontmatters.length; i++) {
      expect(frontmatters[i]).toBe(frontmatters[0]);
    }

    // Sanity check: the description line must be present so we do not
    // accidentally assert equality on two empty strings.
    expect(frontmatters[0]).toMatch(/description:/);
  });
});
