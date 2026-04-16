/**
 * Tests for the platform-agnostic skills renderer / build CLI.
 *
 * Structure by task:
 *   - Task 003: render() placeholder substitution core
 *   - Task 004: render() error handling + assertNoUnresolvedPlaceholders
 *   - Task 005: parseTokenArgs + argument-aware substitution
 *   - Task 006: copyReferences
 *   - Task 007: buildAllSkills orchestrator + escape hatch
 *   - Task 009: buildAllSkills render-time CALL macro failure tests
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import {
  render,
  assertNoUnresolvedPlaceholders,
  parseTokenArgs,
  copyReferences,
  buildAllSkills,
  parseCallMacro,
  renderCallMacros,
  clearRegistryLookup,
  CALL_MACRO_REGEX,
  type CallMacroAst,
} from './build-skills.js';
import { loadRuntime } from './runtimes/load.js';
import type { RuntimeMap, PreferredFacade } from './runtimes/types.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_RUNTIMES_DIR = resolve(__dirname, '..', 'runtimes');

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
    `preferredFacade: mcp`,
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

// -----------------------------------------------------------------------------
// Task 003 (DR-1): Renderer surfaces `preferredFacade` on RuntimeMap consumers
//
// Tasks 001/002 added `preferredFacade` to the schema and every runtime YAML.
// This test pins the contract that downstream renderer consumers (the macro
// work in tasks 005-008) can read `runtime.preferredFacade` directly off the
// loaded `RuntimeMap` — i.e. the field is not dropped anywhere along the
// load → render pipeline and is typed as the expected `'mcp' | 'cli'` union.
// -----------------------------------------------------------------------------
describe('renderer RuntimeMap — task 003 (DR-1)', () => {
  it('Renderer_RuntimeMap_ExposesPreferredFacade', () => {
    // Load a real runtime YAML via the same loader `buildAllSkills` uses.
    const runtime: RuntimeMap = loadRuntime(join(REPO_RUNTIMES_DIR, 'claude.yaml'));

    // Field is present on the RuntimeMap consumer surface.
    expect(runtime.preferredFacade).toBe('mcp');

    // TS-level narrowing: `preferredFacade` is typed as the `PreferredFacade`
    // ('mcp' | 'cli') union. The assignment below must compile without a cast;
    // if a future edit strips the field off the renderer-facing type, this
    // line fails typecheck (the assertion in the task spec).
    const facade: PreferredFacade = runtime.preferredFacade;
    expect(facade === 'mcp' || facade === 'cli').toBe(true);
  });

  it('Renderer_RuntimeMap_PreferredFacade_CliVariant', () => {
    // A runtime that prefers the CLI facade — confirms both enum values flow
    // through the renderer-facing type without special-casing.
    const runtime: RuntimeMap = loadRuntime(join(REPO_RUNTIMES_DIR, 'generic.yaml'));
    expect(runtime.preferredFacade).toBe('cli');

    const facade: PreferredFacade = runtime.preferredFacade;
    expect(facade === 'mcp' || facade === 'cli').toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Task 005 (dual-facade): parseCallMacro — CALL macro parser
// -----------------------------------------------------------------------------

describe('parseCallMacro', () => {
  it('ParseCallMacro_ValidInput_ReturnsTypedAst', () => {
    const result = parseCallMacro('exarchos_workflow set {"featureId":"X","phase":"plan"}');
    expect(result).toEqual({
      tool: 'exarchos_workflow',
      action: 'set',
      args: { featureId: 'X', phase: 'plan' },
    });
  });

  it('ParseCallMacro_AllKnownTools_ParsesSuccessfully', () => {
    const tools = ['exarchos_workflow', 'exarchos_event', 'exarchos_orchestrate', 'exarchos_view'];
    for (const tool of tools) {
      const result = parseCallMacro(`${tool} get {}`);
      expect(result.tool).toBe(tool);
      expect(result.action).toBe('get');
      expect(result.args).toEqual({});
    }
  });

  it('ParseCallMacro_ComplexJsonArgs_ParsesNestedObjects', () => {
    const raw = 'exarchos_event emit {"type":"status","payload":{"level":3,"tags":["a","b"]}}';
    const result = parseCallMacro(raw);
    expect(result).toEqual({
      tool: 'exarchos_event',
      action: 'emit',
      args: { type: 'status', payload: { level: 3, tags: ['a', 'b'] } },
    });
  });

  it('ParseCallMacro_MalformedJson_ThrowsDescriptiveError', () => {
    expect(() => parseCallMacro('exarchos_workflow set {bad json}')).toThrow(
      /JSON|parse|malformed/i,
    );
  });

  it('ParseCallMacro_UnknownTool_ThrowsReferencingRegistry', () => {
    expect(() => parseCallMacro('unknown_tool get {}')).toThrow(
      /unknown tool|not in registry|not a known tool/i,
    );
  });

  it('ParseCallMacro_MissingAction_ThrowsDescriptiveError', () => {
    // Only tool name and JSON, no action token
    expect(() => parseCallMacro('exarchos_workflow {"featureId":"X"}')).toThrow(
      /parse|format|expected/i,
    );
  });

  it('ParseCallMacro_MissingJsonArgs_ThrowsDescriptiveError', () => {
    // Tool + action but no JSON body
    expect(() => parseCallMacro('exarchos_workflow set')).toThrow(
      /parse|format|expected|JSON/i,
    );
  });

  it('ParseCallMacro_Roundtrip_ParseSerializeIdentity', () => {
    // Property test: parse(serialize(ast)) === ast for valid ASTs
    const original: CallMacroAst = {
      tool: 'exarchos_view',
      action: 'summary',
      args: { featureId: 'feat-123', verbose: true },
    };
    const serialized = `${original.tool} ${original.action} ${JSON.stringify(original.args)}`;
    const parsed = parseCallMacro(serialized);
    expect(parsed).toEqual(original);
  });

  it('CALL_MACRO_REGEX_ExtractsContent_ParseCallMacroConsumesIt', () => {
    // End-to-end: CALL_MACRO_REGEX captures the raw string that
    // parseCallMacro expects — the two compose cleanly.
    const body = 'before {{CALL exarchos_workflow set {"phase":"plan"}}} after';
    const matches = [...body.matchAll(CALL_MACRO_REGEX)];
    expect(matches).toHaveLength(1);
    const raw = matches[0][1];
    expect(raw).toBe('exarchos_workflow set {"phase":"plan"}');
    const ast = parseCallMacro(raw);
    expect(ast).toEqual({
      tool: 'exarchos_workflow',
      action: 'set',
      args: { phase: 'plan' },
    });
  });

  it('CALL_MACRO_REGEX_MultipleCallsInBody_MatchesAll', () => {
    const body = [
      '{{CALL exarchos_workflow set {"phase":"plan"}}}',
      'some text',
      '{{CALL exarchos_event emit {"type":"done"}}}',
    ].join('\n');
    const matches = [...body.matchAll(CALL_MACRO_REGEX)];
    expect(matches).toHaveLength(2);
    expect(parseCallMacro(matches[0][1]).tool).toBe('exarchos_workflow');
    expect(parseCallMacro(matches[1][1]).tool).toBe('exarchos_event');
  });
});

// -----------------------------------------------------------------------------
// Task 006 (dual-facade): validateCallMacro — registry validation
// -----------------------------------------------------------------------------

describe('validateCallMacro', () => {
  // Import the real registry lookup from the MCP server package. Test files
  // are excluded from the root tsconfig (`exclude: ["**/*.test.ts"]`) so the
  // cross-package import works fine under vitest even though src/build-skills.ts
  // itself cannot import from the MCP server due to rootDir boundaries.
  let validateCallMacro: typeof import('./build-skills.js').validateCallMacro;
  let setRegistryLookup: typeof import('./build-skills.js').setRegistryLookup;

  beforeAll(async () => {
    const buildSkills = await import('./build-skills.js');
    const registry = await import('../servers/exarchos-mcp/src/registry.js');
    validateCallMacro = buildSkills.validateCallMacro;
    setRegistryLookup = buildSkills.setRegistryLookup;
    // Wire the real registry lookup so validateCallMacro can resolve schemas.
    setRegistryLookup(registry.findActionInRegistry);
  });

  // Clear the module-level registry lookup after this block so it does
  // not leak into later describe blocks (e.g. renderCallMacros tests
  // that use fixture data not matching real schemas).
  afterAll(() => {
    clearRegistryLookup();
  });

  it('ValidateCallMacro_UnknownAction_FailsAtBuildTime', () => {
    const ast: CallMacroAst = {
      tool: 'exarchos_workflow',
      action: 'nonexistent',
      args: {},
    };
    expect(() => validateCallMacro(ast)).toThrow(/unknown action/i);
  });

  it('ValidateCallMacro_InvalidArgs_FailsWithZodError', () => {
    // exarchos_workflow set expects featureId as string, not number
    const ast: CallMacroAst = {
      tool: 'exarchos_workflow',
      action: 'set',
      args: { featureId: 123 },
    };
    expect(() => validateCallMacro(ast)).toThrow(/validation|invalid|expected/i);
  });

  it('ValidateCallMacro_ValidCall_Passes', () => {
    const ast: CallMacroAst = {
      tool: 'exarchos_workflow',
      action: 'set',
      args: { featureId: 'my-feature', phase: 'plan' },
    };
    expect(() => validateCallMacro(ast)).not.toThrow();
  });

  it('ValidateCallMacro_UnknownTool_FailsAtBuildTime', () => {
    const ast: CallMacroAst = {
      tool: 'exarchos_nonexistent',
      action: 'get',
      args: {},
    };
    expect(() => validateCallMacro(ast)).toThrow(/unknown action/i);
  });
});

// -----------------------------------------------------------------------------
// Task 007 (dual-facade): renderCallMacros — MCP facade rendering
// -----------------------------------------------------------------------------

describe('renderCallMacros — MCP facade', () => {
  /**
   * Helper: build a minimal RuntimeMap fixture with the given facade and prefix.
   * Only the fields that `renderCallMacros` needs are populated; the rest are
   * set to sensible defaults so the type is satisfied.
   */
  function makeRuntime(overrides: {
    preferredFacade: 'mcp' | 'cli';
    mcpPrefix: string;
  }): RuntimeMap {
    return {
      name: 'test-runtime',
      preferredFacade: overrides.preferredFacade,
      capabilities: {
        hasSubagents: true,
        hasSlashCommands: true,
        hasHooks: true,
        hasSkillChaining: true,
        mcpPrefix: overrides.mcpPrefix,
      },
      skillsInstallPath: '~/.test/skills',
      detection: { binaries: ['test'], envVars: ['TEST'] },
      placeholders: {},
    };
  }

  it('RenderCallMacro_McpFacade_EmitsToolUseBlockWithPrefix', () => {
    const runtime = makeRuntime({
      preferredFacade: 'mcp',
      mcpPrefix: 'mcp__plugin_exarchos_exarchos__',
    });
    const input = '{{CALL exarchos_workflow set {"featureId":"X","phase":"plan"}}}';
    const output = renderCallMacros(input, runtime);

    // The output should contain the full prefixed tool name
    expect(output).toContain('mcp__plugin_exarchos_exarchos__exarchos_workflow');
    // The action discriminator must be injected into the args
    expect(output).toContain('"action": "set"');
    // Original args must be present
    expect(output).toContain('"featureId": "X"');
    expect(output).toContain('"phase": "plan"');
  });

  it('RenderCallMacro_McpFacade_ActionFieldComesFirst', () => {
    const runtime = makeRuntime({
      preferredFacade: 'mcp',
      mcpPrefix: 'mcp__plugin_exarchos_exarchos__',
    });
    const input = '{{CALL exarchos_workflow set {"featureId":"X","phase":"plan"}}}';
    const output = renderCallMacros(input, runtime);

    // action field should appear before featureId in the serialized output
    const actionIdx = output.indexOf('"action"');
    const featureIdx = output.indexOf('"featureId"');
    expect(actionIdx).toBeLessThan(featureIdx);
  });

  it('RenderCallMacro_McpFacade_OutputFormat', () => {
    const runtime = makeRuntime({
      preferredFacade: 'mcp',
      mcpPrefix: 'mcp__test__',
    });
    const input = '{{CALL exarchos_event emit {"type":"done"}}}';
    const output = renderCallMacros(input, runtime);

    // Full format check: prefix + tool + parenthesized JSON
    expect(output).toMatch(/^mcp__test__exarchos_event\(/);
    expect(output).toMatch(/\)$/);
    // Parse the JSON inside the parens to verify structure
    const jsonMatch = output.match(/\((.+)\)$/s);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed).toEqual({ action: 'emit', type: 'done' });
  });

  it('RenderCallMacro_McpFacade_MultipleCallsInBody', () => {
    const runtime = makeRuntime({
      preferredFacade: 'mcp',
      mcpPrefix: 'mcp__test__',
    });
    const input = [
      'Before: {{CALL exarchos_workflow set {"featureId":"X","phase":"plan"}}}',
      'Middle text',
      'After: {{CALL exarchos_event emit {"type":"done"}}}',
    ].join('\n');
    const output = renderCallMacros(input, runtime);

    expect(output).toContain('mcp__test__exarchos_workflow');
    expect(output).toContain('mcp__test__exarchos_event');
    // Surrounding text preserved
    expect(output).toContain('Before:');
    expect(output).toContain('Middle text');
    expect(output).toContain('After:');
  });

  it('RenderCallMacro_McpFacade_EmptyArgs', () => {
    const runtime = makeRuntime({
      preferredFacade: 'mcp',
      mcpPrefix: 'mcp__test__',
    });
    const input = '{{CALL exarchos_view summary {}}}';
    const output = renderCallMacros(input, runtime);

    const jsonMatch = output.match(/\((.+)\)$/s);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed).toEqual({ action: 'summary' });
  });

  it('RenderCallMacro_CliFacade_EmitsBashCliInvocation', () => {
    const runtime = makeRuntime({
      preferredFacade: 'cli',
      mcpPrefix: 'mcp__test__',
    });
    const input = '{{CALL exarchos_workflow set {"featureId":"X","phase":"plan"}}}';
    const output = renderCallMacros(input, runtime);

    // CLI facade renders a Bash-style CLI invocation with kebab-case flags
    expect(output).toBe('Bash(exarchos workflow set --feature-id X --phase plan --json)');
  });

  it('RenderCallMacro_NoCallMacros_ReturnsBodyUnchanged', () => {
    const runtime = makeRuntime({
      preferredFacade: 'mcp',
      mcpPrefix: 'mcp__test__',
    });
    const input = 'plain text with {{PLACEHOLDER}} tokens but no CALL macros';
    const output = renderCallMacros(input, runtime);

    expect(output).toBe(input);
  });

  it('RenderCallMacro_McpFacade_UsesRuntimeMcpPrefix', () => {
    // Different prefix => different output
    const runtime = makeRuntime({
      preferredFacade: 'mcp',
      mcpPrefix: 'mcp__custom_prefix__',
    });
    const input = '{{CALL exarchos_workflow set {"featureId":"X"}}}';
    const output = renderCallMacros(input, runtime);

    expect(output).toContain('mcp__custom_prefix__exarchos_workflow');
    expect(output).not.toContain('mcp__plugin_exarchos_exarchos__');
  });
});

// -----------------------------------------------------------------------------
// Task 020: renderCallMacros — missing-facade remediation (DR-5)
// -----------------------------------------------------------------------------

describe('renderCallMacros — missing-facade remediation', () => {
  /**
   * Helper: build a minimal RuntimeMap fixture with the given facade and prefix.
   * Duplicated locally so this describe block is self-contained.
   */
  function makeRuntime(overrides: {
    preferredFacade: 'mcp' | 'cli';
    mcpPrefix: string;
  }): RuntimeMap {
    return {
      name: 'test-runtime',
      preferredFacade: overrides.preferredFacade,
      capabilities: {
        hasSubagents: true,
        hasSlashCommands: true,
        hasHooks: true,
        hasSkillChaining: true,
        mcpPrefix: overrides.mcpPrefix,
      },
      skillsInstallPath: '~/.test/skills',
      detection: { binaries: ['test'], envVars: ['TEST'] },
      placeholders: {},
    };
  }

  it('McpMissingAtRuntime_RenderedSkillEmitsActionableError', () => {
    // When the primary facade is MCP, the rendered output must include a
    // fallback pointer to the CLI form so an agent can recover if MCP is
    // unavailable at runtime (DR-5).
    const runtime = makeRuntime({
      preferredFacade: 'mcp',
      mcpPrefix: 'mcp__plugin_exarchos_exarchos__',
    });
    const input = '{{CALL exarchos_workflow set {"featureId":"X","phase":"plan"}}}';
    const output = renderCallMacros(input, runtime);

    // Primary form still rendered
    expect(output).toContain('mcp__plugin_exarchos_exarchos__exarchos_workflow');

    // Fallback remediation comment must be present as an HTML comment
    expect(output).toContain('<!-- If MCP is unavailable');

    // Fallback must point to the CLI form so the agent can use it directly
    expect(output).toContain(
      'Bash(exarchos workflow set --feature-id X --phase plan --json)',
    );

    // HTML comment must be closed (no dangling comment)
    expect(output).toContain('-->');
  });

  it('BashMissingAtRuntime_RenderedSkillEmitsActionableError', () => {
    // When the primary facade is CLI, the rendered output must include a
    // fallback pointer to the MCP tool_use form so an agent can recover if
    // Bash is unavailable at runtime (DR-5).
    const runtime = makeRuntime({
      preferredFacade: 'cli',
      mcpPrefix: 'mcp__plugin_exarchos_exarchos__',
    });
    const input = '{{CALL exarchos_workflow set {"featureId":"X","phase":"plan"}}}';
    const output = renderCallMacros(input, runtime);

    // Primary form still rendered
    expect(output).toContain(
      'Bash(exarchos workflow set --feature-id X --phase plan --json)',
    );

    // Fallback remediation comment must be present as an HTML comment
    expect(output).toContain('<!-- If Bash is unavailable');

    // Fallback must point to the MCP tool_use form so the agent can use it
    expect(output).toContain('mcp__plugin_exarchos_exarchos__exarchos_workflow');

    // Fallback MCP form must contain the action discriminator and args
    expect(output).toMatch(/"action"\s*:\s*"set"/);
    expect(output).toMatch(/"featureId"\s*:\s*"X"/);
    expect(output).toMatch(/"phase"\s*:\s*"plan"/);

    // HTML comment must be closed (no dangling comment)
    expect(output).toContain('-->');
  });

  it('McpFallback_SingleLineCommentForScanability', () => {
    // The fallback comment must be on a single line so it's easy to scan
    // (spec requirement).
    const runtime = makeRuntime({
      preferredFacade: 'mcp',
      mcpPrefix: 'mcp__test__',
    });
    const input = '{{CALL exarchos_workflow set {"featureId":"X","phase":"plan"}}}';
    const output = renderCallMacros(input, runtime);

    const commentLine = output
      .split('\n')
      .find((l) => l.includes('If MCP is unavailable'));
    expect(commentLine).toBeDefined();
    // The entire comment (open to close) must live on a single line
    expect(commentLine!).toContain('<!--');
    expect(commentLine!).toContain('-->');
  });

  it('CliFallback_SingleLineCommentForScanability', () => {
    const runtime = makeRuntime({
      preferredFacade: 'cli',
      mcpPrefix: 'mcp__test__',
    });
    const input = '{{CALL exarchos_workflow set {"featureId":"X","phase":"plan"}}}';
    const output = renderCallMacros(input, runtime);

    const commentLine = output
      .split('\n')
      .find((l) => l.includes('If Bash is unavailable'));
    expect(commentLine).toBeDefined();
    expect(commentLine!).toContain('<!--');
    expect(commentLine!).toContain('-->');
  });
});

// -----------------------------------------------------------------------------
// Task 009: Render-time CALL macro failure in buildAllSkills
// -----------------------------------------------------------------------------

describe('buildAllSkills — task 009: render-time CALL macro failures', () => {
  // Wire the real registry lookup before these tests run so that
  // validateCallMacro can resolve action schemas.
  beforeAll(async () => {
    const buildSkills = await import('./build-skills.js');
    const registry = await import('../servers/exarchos-mcp/src/registry.js');
    buildSkills.setRegistryLookup(registry.findActionInRegistry);
  });

  it('BuildAllSkills_CallMacroWithUnknownAction_FailsFast', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'skills-src');
    const outDir = join(root, 'skills');
    mkdirSync(join(srcDir, 'bad-action'), { recursive: true });
    writeFileSync(
      join(srcDir, 'bad-action', 'SKILL.md'),
      '{{CALL exarchos_workflow NONEXISTENT_ACTION {"featureId":"X"}}}',
    );

    let err: Error | undefined;
    try {
      buildAllSkills({ srcDir, outDir, runtimesDir: REPO_RUNTIMES_DIR });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    // Error must reference the skill source path
    expect(err!.message).toContain('bad-action');
    // Error must reference the unknown action (from validateCallMacro)
    expect(err!.message).toMatch(/unknown action.*NONEXISTENT_ACTION/i);
  });

  it('BuildAllSkills_CallMacroArgsFailSchema_FailsFast', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'skills-src');
    const outDir = join(root, 'skills');
    mkdirSync(join(srcDir, 'bad-args'), { recursive: true });
    // "set" requires at minimum featureId — empty args should fail validation
    writeFileSync(
      join(srcDir, 'bad-args', 'SKILL.md'),
      '{{CALL exarchos_workflow set {}}}',
    );

    let err: Error | undefined;
    try {
      buildAllSkills({ srcDir, outDir, runtimesDir: REPO_RUNTIMES_DIR });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    // Error must reference the skill source path
    expect(err!.message).toContain('bad-args');
    // Error must reference schema validation failure (from validateCallMacro)
    expect(err!.message).toMatch(/failed schema validation/i);
  });
});
