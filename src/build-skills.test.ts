/**
 * Tests for the platform-agnostic skills renderer / build CLI.
 *
 * Structure by task:
 *   - Task 003: render() placeholder substitution core
 *   - Task 004: render() error handling + assertNoUnresolvedPlaceholders
 *   - Task 005: parseTokenArgs + argument-aware substitution
 *   - Task 006: copyReferences
 *   - Task 007: buildAllSkills orchestrator + escape hatch
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  render,
  assertNoUnresolvedPlaceholders,
  parseTokenArgs,
  copyReferences,
  buildAllSkills,
} from './build-skills.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'build-skills-test-'));
  tempDirs.push(dir);
  return dir;
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

describe('render — task 003: placeholder substitution core', () => {
  it('Render_SimpleToken_SubstitutesValue', () => {
    const body = 'Hello {{NAME}}';
    const out = render(body, { NAME: 'world' });
    expect(out).toBe('Hello world');
  });

  it('Render_MultipleTokens_SubstitutesAll', () => {
    const body = '{{GREETING}}, {{NAME}}!';
    const out = render(body, { GREETING: 'Hi', NAME: 'Ada' });
    expect(out).toBe('Hi, Ada!');
  });

  it('Render_RepeatedToken_SubstitutesAllOccurrences', () => {
    const body = '{{X}} and {{X}} and {{X}}';
    const out = render(body, { X: 'foo' });
    expect(out).toBe('foo and foo and foo');
  });

  it('Render_MultiLineValue_PreservesIndentation', () => {
    // Opening token at column 4 — every subsequent line of the multi-line
    // substitution must be prefixed with 4 spaces so the visual indentation
    // of the rendered block is preserved.
    const body = '    {{BLOCK}}';
    const placeholders = { BLOCK: 'line 1\nline 2\nline 3' };
    const out = render(body, placeholders);
    expect(out).toBe('    line 1\n    line 2\n    line 3');
  });

  it('Render_NoTokens_ReturnsInputUnchanged', () => {
    const body = 'plain text with no placeholders at all';
    const out = render(body, { UNUSED: 'nope' });
    expect(out).toBe(body);
  });

  it('Render_TokenWithSurroundingText_OnlyReplacesToken', () => {
    const body = 'before {{TOKEN}} after';
    const out = render(body, { TOKEN: 'MIDDLE' });
    expect(out).toBe('before MIDDLE after');
  });

  it('Render_Idempotent_SecondRunProducesIdenticalOutput', () => {
    const body = 'a {{X}} b {{Y}} c';
    const placeholders = { X: '1', Y: '2' };
    const first = render(body, placeholders);
    const second = render(first, placeholders);
    // Byte-for-byte identical: idempotence.
    expect(second).toBe(first);
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });
});

describe('render — task 004: error handling', () => {
  it('Render_UnknownPlaceholder_ThrowsWithTokenNameAndLineNumber', () => {
    const body = 'line 1\nline 2 with {{NOPE}}\nline 3';
    const placeholders = { X: 'x' };
    expect(() =>
      render(body, placeholders, { sourcePath: 'skills-src/foo/SKILL.md', runtimeName: 'claude' }),
    ).toThrowError(/\{\{NOPE\}\}/);
    expect(() =>
      render(body, placeholders, { sourcePath: 'skills-src/foo/SKILL.md', runtimeName: 'claude' }),
    ).toThrowError(/skills-src\/foo\/SKILL\.md:2/);
  });

  it('Render_UnknownPlaceholder_ErrorListsKnownTokens', () => {
    const body = '{{UNKNOWN}}';
    const placeholders = { ZEBRA: 'z', APPLE: 'a', MANGO: 'm' };
    let err: Error | undefined;
    try {
      render(body, placeholders, { sourcePath: 'x.md', runtimeName: 'claude' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    // Alphabetically sorted: APPLE, MANGO, ZEBRA
    expect(err!.message).toContain('APPLE, MANGO, ZEBRA');
    expect(err!.message).toContain('runtimes/claude.yaml');
  });

  it('Render_UnresolvedPostRender_ThrowsViaAssert', () => {
    // Residual braces after render: assertNoUnresolvedPlaceholders should
    // flag them. Here we construct dirty output directly.
    const rendered = 'line1\nline2 has {{LEFTOVER}}\nline3';
    expect(() =>
      assertNoUnresolvedPlaceholders(rendered, 'skills/foo/SKILL.md', 'claude'),
    ).toThrow(/\{\{LEFTOVER\}\}/);
  });

  it('AssertNoUnresolvedPlaceholders_CleanInput_DoesNotThrow', () => {
    const clean = 'hello world\nno placeholders here';
    expect(() => assertNoUnresolvedPlaceholders(clean, 'x.md', 'claude')).not.toThrow();
  });

  it('AssertNoUnresolvedPlaceholders_ResidualBraces_ThrowsWithLocation', () => {
    const dirty = 'a\nb\nc\n{{STILL_HERE}}';
    let err: Error | undefined;
    try {
      assertNoUnresolvedPlaceholders(dirty, 'skills/foo/SKILL.md', 'claude');
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('STILL_HERE');
    expect(err!.message).toContain('skills/foo/SKILL.md:4');
  });
});

describe('parseTokenArgs + argument-aware render — task 005', () => {
  it('ParseTokenArgs_NoArgs_ReturnsEmptyMap', () => {
    expect(parseTokenArgs('')).toEqual({});
  });

  it('ParseTokenArgs_SingleArg_ReturnsOneEntry', () => {
    expect(parseTokenArgs('next="plan"')).toEqual({ next: 'plan' });
  });

  it('ParseTokenArgs_MultipleArgs_ReturnsAll', () => {
    expect(parseTokenArgs('next="plan" args="$PLAN" mode="fast"')).toEqual({
      next: 'plan',
      args: '$PLAN',
      mode: 'fast',
    });
  });

  it('ParseTokenArgs_ArgWithSpaces_QuotedCorrectly', () => {
    expect(parseTokenArgs('next="plan file" args="--help"')).toEqual({
      next: 'plan file',
      args: '--help',
    });
  });

  it('ParseTokenArgs_MalformedArg_ThrowsWithContext', () => {
    // Missing closing quote — should throw with context about the broken input.
    expect(() => parseTokenArgs('next="plan')).toThrow(/malformed|unterminated|quote/i);
  });

  it('Render_ChainTokenWithArgs_SubstitutesPlaceholderVariables', () => {
    const body = '{{CHAIN next="plan" args="$PLAN"}}';
    const placeholders = { CHAIN: 'run {{next}} with {{args}}' };
    const out = render(body, placeholders);
    expect(out).toBe('run plan with $PLAN');
  });

  it('Render_ChainTokenWithArgs_ClaudeVariant_ExpandsToSkillCall', () => {
    const body = '{{CHAIN next="plan" args="$PLAN"}}';
    const placeholders = {
      CHAIN: 'Skill({ skill: "exarchos:{{next}}", args: "{{args}}" })',
    };
    const out = render(body, placeholders);
    expect(out).toBe('Skill({ skill: "exarchos:plan", args: "$PLAN" })');
  });

  it('Render_ChainTokenWithArgs_GenericVariant_ExpandsToProseInstruction', () => {
    const body = '{{CHAIN next="plan" args="$PLAN"}}';
    const placeholders = {
      CHAIN: 'Next, invoke the `{{next}}` skill with arguments: {{args}}',
    };
    const out = render(body, placeholders);
    expect(out).toBe('Next, invoke the `plan` skill with arguments: $PLAN');
  });
});

describe('copyReferences — task 006', () => {
  it('CopyReferences_SourceHasReferences_CopiedToTarget', () => {
    const src = makeTempDir();
    const dest = makeTempDir();
    mkdirSync(join(src, 'references'), { recursive: true });
    writeFileSync(join(src, 'references', 'one.md'), 'ref one');
    writeFileSync(join(src, 'references', 'two.md'), 'ref two');

    copyReferences(src, dest);

    expect(readFileSync(join(dest, 'references', 'one.md'), 'utf8')).toBe('ref one');
    expect(readFileSync(join(dest, 'references', 'two.md'), 'utf8')).toBe('ref two');
  });

  it('CopyReferences_NoReferences_NoOp', () => {
    const src = makeTempDir();
    const dest = makeTempDir();
    // src has no `references/` subdir
    copyReferences(src, dest);
    expect(existsSync(join(dest, 'references'))).toBe(false);
  });

  it('CopyReferences_NestedFiles_PreservesStructure', () => {
    const src = makeTempDir();
    const dest = makeTempDir();
    mkdirSync(join(src, 'references', 'a', 'b'), { recursive: true });
    writeFileSync(join(src, 'references', 'a', 'b', 'c.txt'), 'deep');
    writeFileSync(join(src, 'references', 'top.txt'), 'top');

    copyReferences(src, dest);

    expect(readFileSync(join(dest, 'references', 'a', 'b', 'c.txt'), 'utf8')).toBe('deep');
    expect(readFileSync(join(dest, 'references', 'top.txt'), 'utf8')).toBe('top');
  });

  it('CopyReferences_Idempotent_SecondRunIsNoop', () => {
    const src = makeTempDir();
    const dest = makeTempDir();
    mkdirSync(join(src, 'references'), { recursive: true });
    writeFileSync(join(src, 'references', 'stable.md'), 'stable content');

    copyReferences(src, dest);
    const firstStat = statSync(join(dest, 'references', 'stable.md'));

    copyReferences(src, dest);
    const secondStat = statSync(join(dest, 'references', 'stable.md'));

    // Content identical after second run.
    expect(readFileSync(join(dest, 'references', 'stable.md'), 'utf8')).toBe('stable content');
    // mtime preserved → utimesSync pinned it, so the two stats match.
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });

  it('CopyReferences_BinaryFile_CopiedUnchanged', () => {
    const src = makeTempDir();
    const dest = makeTempDir();
    mkdirSync(join(src, 'references'), { recursive: true });
    // Construct a binary blob: all byte values 0..255.
    const binary = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) binary[i] = i;
    writeFileSync(join(src, 'references', 'blob.bin'), binary);
    const srcHash = createHash('sha256').update(binary).digest('hex');

    copyReferences(src, dest);

    const copied = readFileSync(join(dest, 'references', 'blob.bin'));
    const destHash = createHash('sha256').update(copied).digest('hex');
    expect(destHash).toBe(srcHash);
  });
});

// -----------------------------------------------------------------------------
// Task 007 test helpers: lay down a full set of six runtime YAMLs inside a
// temp dir so `buildAllSkills` / `loadAllRuntimes` can be exercised end-to-end.
// -----------------------------------------------------------------------------

interface RuntimeFixtureOverrides {
  placeholders?: Record<string, string>;
}

function makeRuntimeYaml(name: string, placeholders: Record<string, string>): string {
  // Use double-quoted scalars so values do not pick up a trailing newline
  // (block scalars `|` would). Escape backslashes and double quotes.
  const escape = (s: string): string =>
    s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const placeholderLines =
    Object.keys(placeholders).length === 0
      ? '  {}'
      : Object.entries(placeholders)
          .map(([k, v]) => `  ${k}: "${escape(v)}"`)
          .join('\n');
  return [
    `name: ${name}`,
    `capabilities:`,
    `  hasSubagents: true`,
    `  hasSlashCommands: true`,
    `  hasHooks: true`,
    `  hasSkillChaining: true`,
    `  mcpPrefix: "mcp__${name}__"`,
    `skillsInstallPath: "~/.${name}/skills"`,
    `detection:`,
    `  binaries:`,
    `    - ${name}`,
    `  envVars:`,
    `    - ${name.toUpperCase()}_SESSION`,
    `placeholders:`,
    placeholderLines,
    ``,
  ].join('\n');
}

function writeRuntimeFixtures(
  runtimesDir: string,
  overrides: Record<string, RuntimeFixtureOverrides> = {},
): void {
  mkdirSync(runtimesDir, { recursive: true });
  const names = ['generic', 'claude', 'codex', 'opencode', 'copilot', 'cursor'];
  const defaultPlaceholders: Record<string, string> = {
    AGENT_LABEL: 'agent',
    SKILL_INVOCATION: 'call the skill',
  };
  for (const name of names) {
    const override = overrides[name]?.placeholders;
    const placeholders = override ?? defaultPlaceholders;
    writeFileSync(join(runtimesDir, `${name}.yaml`), makeRuntimeYaml(name, placeholders));
  }
}

describe('buildAllSkills — task 007', () => {
  it('BuildAllSkills_OneSkillOneRuntime_GeneratesCorrectPath', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'skills-src');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(join(srcDir, 'foo', 'SKILL.md'), 'Hello {{AGENT_LABEL}}');
    writeRuntimeFixtures(runtimesDir);

    buildAllSkills({ srcDir, outDir, runtimesDir });

    const clauPath = join(outDir, 'claude', 'foo', 'SKILL.md');
    expect(existsSync(clauPath)).toBe(true);
    expect(readFileSync(clauPath, 'utf8')).toBe('Hello agent');
  });

  it('BuildAllSkills_SixRuntimes_GeneratesSixVariants', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'skills-src');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(join(srcDir, 'foo', 'SKILL.md'), '{{AGENT_LABEL}}');
    writeRuntimeFixtures(runtimesDir);

    const report = buildAllSkills({ srcDir, outDir, runtimesDir });

    const runtimes = ['generic', 'claude', 'codex', 'opencode', 'copilot', 'cursor'];
    for (const rt of runtimes) {
      expect(existsSync(join(outDir, rt, 'foo', 'SKILL.md'))).toBe(true);
    }
    expect(report.variantsWritten).toBe(6);
  });

  it('BuildAllSkills_ReferencesSubdirectory_CopiedToEachVariant', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'skills-src');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'runtimes');
    mkdirSync(join(srcDir, 'foo', 'references'), { recursive: true });
    writeFileSync(join(srcDir, 'foo', 'SKILL.md'), '{{AGENT_LABEL}}');
    writeFileSync(join(srcDir, 'foo', 'references', 'note.md'), 'a shared reference');
    writeRuntimeFixtures(runtimesDir);

    buildAllSkills({ srcDir, outDir, runtimesDir });

    const runtimes = ['generic', 'claude', 'codex', 'opencode', 'copilot', 'cursor'];
    for (const rt of runtimes) {
      expect(readFileSync(join(outDir, rt, 'foo', 'references', 'note.md'), 'utf8')).toBe(
        'a shared reference',
      );
    }
  });

  it('BuildAllSkills_RuntimeSpecificOverrideFile_PrefersOverride', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'skills-src');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(join(srcDir, 'foo', 'SKILL.md'), 'default: {{AGENT_LABEL}}');
    // Claude-specific override — used verbatim (no rendering).
    writeFileSync(join(srcDir, 'foo', 'SKILL.claude.md'), 'verbatim claude override {{UNRESOLVED}}');
    writeRuntimeFixtures(runtimesDir);

    const report = buildAllSkills({ srcDir, outDir, runtimesDir });

    // Claude gets the verbatim override (tokens left intact — no rendering).
    expect(readFileSync(join(outDir, 'claude', 'foo', 'SKILL.md'), 'utf8')).toBe(
      'verbatim claude override {{UNRESOLVED}}',
    );
    // Other runtimes still use SKILL.md + render.
    expect(readFileSync(join(outDir, 'codex', 'foo', 'SKILL.md'), 'utf8')).toBe('default: agent');
    // Override usage recorded in report.
    expect(report.overridesUsed.length).toBeGreaterThan(0);
    expect(report.overridesUsed.some((p) => p.includes('SKILL.claude.md'))).toBe(true);
  });

  it('BuildAllSkills_CleansStaleOutput_RemovesOrphanedVariants', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'skills-src');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(join(srcDir, 'foo', 'SKILL.md'), '{{AGENT_LABEL}}');
    writeRuntimeFixtures(runtimesDir);

    // Pre-seed a stale output that is not produced by this build.
    mkdirSync(join(outDir, 'claude', 'old-skill'), { recursive: true });
    writeFileSync(join(outDir, 'claude', 'old-skill', 'SKILL.md'), 'stale content');

    buildAllSkills({ srcDir, outDir, runtimesDir });

    // Stale file removed.
    expect(existsSync(join(outDir, 'claude', 'old-skill', 'SKILL.md'))).toBe(false);
    // Fresh output present.
    expect(existsSync(join(outDir, 'claude', 'foo', 'SKILL.md'))).toBe(true);
  });

  it('BuildAllSkills_EmptySourceDir_Throws', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'skills-src');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'runtimes');
    mkdirSync(srcDir, { recursive: true }); // exists but empty (no SKILL.md files)
    writeRuntimeFixtures(runtimesDir);

    expect(() => buildAllSkills({ srcDir, outDir, runtimesDir })).toThrow(/no.*SKILL\.md|empty/i);
  });

  it('BuildAllSkills_RuntimeWithNoPlaceholders_CopiesUnchanged', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'skills-src');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    // Body with no tokens at all.
    writeFileSync(join(srcDir, 'foo', 'SKILL.md'), 'plain content no tokens');
    // Generic has no placeholders — should still copy unchanged.
    writeRuntimeFixtures(runtimesDir, { generic: { placeholders: {} } });

    buildAllSkills({ srcDir, outDir, runtimesDir });

    expect(readFileSync(join(outDir, 'generic', 'foo', 'SKILL.md'), 'utf8')).toBe(
      'plain content no tokens',
    );
  });
});
