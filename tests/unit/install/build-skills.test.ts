/**
 * Tests for the skills renderer, which `src/install/build-skills.ts` exports. They cover
 * placeholder substitution, token arguments, reference copy, CALL macros, `requires` guards,
 * the vocabulary lint, skill classification, and `buildAllSkills`.
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
  classifySkill,
  assertProceduralSkill,
  assertRuntimeTokenCoverage,
  ORCHESTRATION_TOKENS,
  PREFIX_TOKENS,
  CALL_MACRO_REGEX,
  type CallMacroAst,
} from '../../../src/install/build-skills.js';
import { loadRuntime } from '../../../src/install/runtimes/load.js';
import { RuntimeTokenKey } from '../../../src/install/runtimes/types.js';
import type { RuntimeMap, PreferredFacade } from '../../../src/install/runtimes/types.js';
import { runSkillsGuard } from '../../../src/install/skills-guard.js';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_RUNTIMES_DIR = resolve(__dirname, '../../../content/harness/runtimes');

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'build-skills-test-'));
  tempDirs.push(dir);
  return dir;
}

/** Removes each temp directory. A removal error does not fail the test. */
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      rmrf(d);
    } catch {
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

  /** The token opens at column 4, so each later line of the value gets 4 spaces of indent. */
  it('Render_MultiLineValue_PreservesIndentation', () => {
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
    expect(second).toBe(first);
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });
});

describe('render — task 004: error handling', () => {
  it('Render_UnknownPlaceholder_ThrowsWithTokenNameAndLineNumber', () => {
    const body = 'line 1\nline 2 with {{NOPE}}\nline 3';
    const placeholders = { X: 'x' };
    expect(() =>
      render(body, placeholders, { sourcePath: 'content/foo/SKILL.md', runtimeName: 'claude' }),
    ).toThrowError(/\{\{NOPE\}\}/);
    expect(() =>
      render(body, placeholders, { sourcePath: 'content/foo/SKILL.md', runtimeName: 'claude' }),
    ).toThrowError(/content\/foo\/SKILL\.md:2/);
  });

  /** The error lists the known tokens in alphabetical order and names the runtime YAML file. */
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
    expect(err!.message).toContain('APPLE, MANGO, ZEBRA');
    expect(err!.message).toContain('content/harness/runtimes/claude.yaml');
  });

  /** The input is a hand-written string with a leftover token, not the output of `render`. */
  it('Render_UnresolvedPostRender_ThrowsViaAssert', () => {
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

  /** The value has no closing quote. */
  it('ParseTokenArgs_MalformedArg_ThrowsWithContext', () => {
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

  /** Each copy sets the file mtime to the source mtime, so a second copy gives the same mtime. */
  it('CopyReferences_Idempotent_SecondRunIsNoop', () => {
    const src = makeTempDir();
    const dest = makeTempDir();
    mkdirSync(join(src, 'references'), { recursive: true });
    writeFileSync(join(src, 'references', 'stable.md'), 'stable content');

    copyReferences(src, dest);
    const firstStat = statSync(join(dest, 'references', 'stable.md'));

    copyReferences(src, dest);
    const secondStat = statSync(join(dest, 'references', 'stable.md'));

    expect(readFileSync(join(dest, 'references', 'stable.md'), 'utf8')).toBe('stable content');
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });

  /** The file holds each byte value from 0 to 255. */
  it('CopyReferences_BinaryFile_CopiedUnchanged', () => {
    const src = makeTempDir();
    const dest = makeTempDir();
    mkdirSync(join(src, 'references'), { recursive: true });
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

interface RuntimeFixtureOverrides {
  placeholders?: Record<string, string>;
}

/**
 * Builds the YAML of one runtime fixture. Each placeholder value is a double-quoted scalar
 * with escapes, because a block scalar adds a trailing newline to the value.
 */
function makeRuntimeYaml(name: string, placeholders: Record<string, string>): string {
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

/**
 * Writes the six runtime YAML files that `loadAllRuntimes` requires. Each runtime gets the full
 * default placeholder set, because `assertRuntimeTokenCoverage` fails the build on a missing token.
 * An override merges over the defaults, so an empty override map still gives the full default set.
 */
function writeRuntimeFixtures(
  runtimesDir: string,
  overrides: Record<string, RuntimeFixtureOverrides> = {},
): void {
  mkdirSync(runtimesDir, { recursive: true });
  const names = ['generic', 'claude', 'codex', 'opencode', 'copilot', 'cursor'];
  const defaultPlaceholders: Record<string, string> = {
    AGENT_LABEL: 'agent',
    SKILL_INVOCATION: 'call the skill',
    MCP_PREFIX: 'mcp__test__',
    COMMAND_PREFIX: '/',
    TASK_TOOL: 'Task',
    CHAIN: '[invoke {{next}} with {{args}}]',
    SPAWN_AGENT_CALL: 'Task({ prompt: "{{prompt}}" })',
    SUBAGENT_COMPLETION_HOOK: 'subagent completion signal (poll-based)',
    SUBAGENT_RESULT_API: '[poll subagent result]',
  };
  for (const name of names) {
    const override = overrides[name]?.placeholders;
    const placeholders = override !== undefined ? { ...defaultPlaceholders, ...override } : defaultPlaceholders;
    writeFileSync(join(runtimesDir, `${name}.yaml`), makeRuntimeYaml(name, placeholders));
  }
}

/**
 * A fixture source that holds `{{TASK_TOOL}}`, an orchestration token, renders one variant for
 * each runtime. A source with no orchestration token renders once to the `standard` tree.
 */
describe('buildAllSkills — task 007', () => {
  it('BuildAllSkills_OneSkillOneRuntime_GeneratesCorrectPath', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(join(srcDir, 'foo', 'SKILL.md'), 'Hello {{AGENT_LABEL}} {{TASK_TOOL}}');
    writeRuntimeFixtures(runtimesDir);

    buildAllSkills({ srcDir, outDir, runtimesDir });

    const clauPath = join(outDir, 'claude', 'foo', 'SKILL.md');
    expect(existsSync(clauPath)).toBe(true);
    expect(readFileSync(clauPath, 'utf8')).toBe('Hello agent Task');
  });

  it('BuildAllSkills_SixRuntimes_GeneratesSixVariants', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(join(srcDir, 'foo', 'SKILL.md'), '{{AGENT_LABEL}} {{TASK_TOOL}}');
    writeRuntimeFixtures(runtimesDir);

    const report = buildAllSkills({ srcDir, outDir, runtimesDir });

    const runtimes = ['generic', 'claude', 'codex', 'opencode', 'copilot', 'cursor'];
    for (const rt of runtimes) {
      expect(existsSync(join(outDir, rt, 'foo', 'SKILL.md'))).toBe(true);
    }
    expect(report.variantsWritten).toBe(6);
  });

  /** The build copies a reference file only when the rendered SKILL.md links to it. */
  it('BuildAllSkills_ReferencesSubdirectory_CopiedToEachVariant', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo', 'references'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      '{{AGENT_LABEL}} {{TASK_TOOL}} — see [note](references/note.md)',
    );
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

  /**
   * The build copies `SKILL.claude.md` verbatim, so its `{{UNRESOLVED}}` token stays in the
   * Claude output. The other runtimes render `SKILL.md`. The report records the override path.
   */
  it('BuildAllSkills_RuntimeSpecificOverrideFile_PrefersOverride', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(join(srcDir, 'foo', 'SKILL.md'), 'default: {{AGENT_LABEL}} {{TASK_TOOL}}');
    writeFileSync(join(srcDir, 'foo', 'SKILL.claude.md'), 'verbatim claude override {{UNRESOLVED}}');
    writeRuntimeFixtures(runtimesDir);

    const report = buildAllSkills({ srcDir, outDir, runtimesDir });

    expect(readFileSync(join(outDir, 'claude', 'foo', 'SKILL.md'), 'utf8')).toBe(
      'verbatim claude override {{UNRESOLVED}}',
    );
    expect(readFileSync(join(outDir, 'codex', 'foo', 'SKILL.md'), 'utf8')).toBe('default: agent Task');
    expect(report.overridesUsed.length).toBeGreaterThan(0);
    expect(report.overridesUsed.some((p) => p.includes('SKILL.claude.md'))).toBe(true);
  });

  it('BuildAllSkills_CleansStaleOutput_RemovesOrphanedVariants', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(join(srcDir, 'foo', 'SKILL.md'), '{{AGENT_LABEL}} {{TASK_TOOL}}');
    writeRuntimeFixtures(runtimesDir);

    mkdirSync(join(outDir, 'claude', 'old-skill'), { recursive: true });
    writeFileSync(join(outDir, 'claude', 'old-skill', 'SKILL.md'), 'stale content');

    buildAllSkills({ srcDir, outDir, runtimesDir });

    expect(existsSync(join(outDir, 'claude', 'old-skill', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(outDir, 'claude', 'foo', 'SKILL.md'))).toBe(true);
  });

  it('BuildAllSkills_EmptySourceDir_Throws', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(srcDir, { recursive: true });
    writeRuntimeFixtures(runtimesDir);

    expect(() => buildAllSkills({ srcDir, outDir, runtimesDir })).toThrow(/no.*SKILL\.md|empty/i);
  });

  /**
   * A body with no token is a procedural skill, so it renders once to `standard/foo`. The empty
   * `generic` override merges over the defaults, so no runtime has an empty placeholder map.
   */
  it('BuildAllSkills_RuntimeWithNoPlaceholders_CopiesUnchanged', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(join(srcDir, 'foo', 'SKILL.md'), 'plain content no tokens');
    writeRuntimeFixtures(runtimesDir, { generic: { placeholders: {} } });

    buildAllSkills({ srcDir, outDir, runtimesDir });

    expect(readFileSync(join(outDir, 'standard', 'foo', 'SKILL.md'), 'utf8')).toBe(
      'plain content no tokens',
    );
  });
});

/**
 * The loaded `RuntimeMap` must keep `preferredFacade`. Both tests load a real runtime YAML
 * file: `claude.yaml` declares `mcp` and `generic.yaml` declares `cli`. The assignment to a
 * `PreferredFacade` constant checks the type only when a typecheck covers this file.
 */
describe('renderer RuntimeMap — task 003 (DR-1)', () => {
  it('Renderer_RuntimeMap_ExposesPreferredFacade', () => {
    const runtime: RuntimeMap = loadRuntime(join(REPO_RUNTIMES_DIR, 'claude.yaml'));

    expect(runtime.preferredFacade).toBe('mcp');

    const facade: PreferredFacade = runtime.preferredFacade;
    expect(facade === 'mcp' || facade === 'cli').toBe(true);
  });

  it('Renderer_RuntimeMap_PreferredFacade_CliVariant', () => {
    const runtime: RuntimeMap = loadRuntime(join(REPO_RUNTIMES_DIR, 'generic.yaml'));
    expect(runtime.preferredFacade).toBe('cli');

    const facade: PreferredFacade = runtime.preferredFacade;
    expect(facade === 'mcp' || facade === 'cli').toBe(true);
  });
});

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
    expect(() => parseCallMacro('exarchos_workflow {"featureId":"X"}')).toThrow(
      /parse|format|expected/i,
    );
  });

  it('ParseCallMacro_MissingJsonArgs_ThrowsDescriptiveError', () => {
    expect(() => parseCallMacro('exarchos_workflow set')).toThrow(
      /parse|format|expected|JSON/i,
    );
  });

  it('ParseCallMacro_Roundtrip_ParseSerializeIdentity', () => {
    const original: CallMacroAst = {
      tool: 'exarchos_view',
      action: 'summary',
      args: { featureId: 'feat-123', verbose: true },
    };
    const serialized = `${original.tool} ${original.action} ${JSON.stringify(original.args)}`;
    const parsed = parseCallMacro(serialized);
    expect(parsed).toEqual(original);
  });

  /** Group 1 of `CALL_MACRO_REGEX` is the raw string that `parseCallMacro` takes. */
  it('CALL_MACRO_REGEX_ExtractsContent_ParseCallMacroConsumesIt', () => {
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

/**
 * The `beforeAll` hook wires the real registry lookup, `findActionInRegistry`. The `afterAll`
 * hook clears it, because the `renderCallMacros` blocks that follow use calls that the real
 * registry rejects. One example is the `set` action of `exarchos_workflow`, which is absent.
 */
describe('validateCallMacro', () => {
  let validateCallMacro: typeof import('../../../src/install/build-skills.js').validateCallMacro;
  let setRegistryLookup: typeof import('../../../src/install/build-skills.js').setRegistryLookup;

  beforeAll(async () => {
    const buildSkills = await import('../../../src/install/build-skills.js');
    const registry = await import('../../../src/registry.js');
    validateCallMacro = buildSkills.validateCallMacro;
    setRegistryLookup = buildSkills.setRegistryLookup;
    setRegistryLookup(registry.findActionInRegistry);
  });

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

  /** `featureId` must be a string, and the fixture passes a number. */
  it('ValidateCallMacro_InvalidArgs_FailsWithZodError', () => {
    const ast: CallMacroAst = {
      tool: 'exarchos_workflow',
      action: 'transition',
      args: { featureId: 123, target: 'plan' },
    };
    expect(() => validateCallMacro(ast)).toThrow(/validation|invalid|expected/i);
  });

  it('ValidateCallMacro_ValidCall_Passes', () => {
    const ast: CallMacroAst = {
      tool: 'exarchos_workflow',
      action: 'transition',
      args: { featureId: 'my-feature', target: 'plan' },
    };
    expect(() => validateCallMacro(ast)).not.toThrow();
  });

  /** The tool name is valid, and only the action is unknown. */
  it('ValidateCallMacro_UnknownAction_FailsAtBuildTime', () => {
    const ast: CallMacroAst = {
      tool: 'exarchos_workflow',
      action: 'nonexistent_action',
      args: {},
    };
    expect(() => validateCallMacro(ast)).toThrow(/unknown action/i);
  });
});

/**
 * `makeRuntime` builds a `RuntimeMap` with the given facade and MCP prefix, and fixed values
 * for the other fields. Each rendered call ends with a fallback HTML comment on a new line.
 * A test that parses the primary form splits the output at that comment.
 */
describe('renderCallMacros — MCP facade', () => {
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
        hasSkillChaining: true,
        mcpPrefix: overrides.mcpPrefix,
      },
      skillsInstallPath: '~/.test/skills',
      detection: { binaries: ['test'], envVars: ['TEST'] },
      placeholders: {},
    };
  }

  /** The output holds the prefixed tool name, the injected `action` field, and the given args. */
  it('RenderCallMacro_McpFacade_EmitsToolUseBlockWithPrefix', () => {
    const runtime = makeRuntime({
      preferredFacade: 'mcp',
      mcpPrefix: 'mcp__plugin_exarchos_exarchos__',
    });
    const input = '{{CALL exarchos_workflow set {"featureId":"X","phase":"plan"}}}';
    const output = renderCallMacros(input, runtime);

    expect(output).toContain('mcp__plugin_exarchos_exarchos__exarchos_workflow');
    expect(output).toContain('"action": "set"');
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

    const actionIdx = output.indexOf('"action"');
    const featureIdx = output.indexOf('"featureId"');
    expect(actionIdx).toBeLessThan(featureIdx);
  });

  /** The primary form is the prefixed tool name, then the JSON args in parentheses. */
  it('RenderCallMacro_McpFacade_OutputFormat', () => {
    const runtime = makeRuntime({
      preferredFacade: 'mcp',
      mcpPrefix: 'mcp__test__',
    });
    const input = '{{CALL exarchos_event emit {"type":"done"}}}';
    const output = renderCallMacros(input, runtime);

    const [primary] = output.split('\n<!--');
    expect(primary).toMatch(/^mcp__test__exarchos_event\(/);
    expect(primary).toMatch(/\)$/);
    const jsonMatch = primary.match(/\((.+)\)$/s);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed).toEqual({ action: 'emit', type: 'done' });
    expect(output).toContain('<!-- If MCP is unavailable');
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

    const [primary] = output.split('\n<!--');
    const jsonMatch = primary.match(/\((.+)\)$/s);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed).toEqual({ action: 'summary' });
  });

  /** The CLI facade renders a `Bash(...)` call with kebab-case flags, then the fallback comment. */
  it('RenderCallMacro_CliFacade_EmitsBashCliInvocation', () => {
    const runtime = makeRuntime({
      preferredFacade: 'cli',
      mcpPrefix: 'mcp__test__',
    });
    const input = '{{CALL exarchos_workflow set {"featureId":"X","phase":"plan"}}}';
    const output = renderCallMacros(input, runtime);

    expect(output).toContain(
      'Bash(exarchos workflow set --feature-id X --phase plan --json)',
    );
    expect(output).toContain('<!-- If Bash is unavailable');
  });

  /** `true` gives the bare flag `--dry-run`, and `false` gives `--no-dry-run`. */
  it('RenderCallMacro_CliFacade_BooleanArgsEmitNoArgumentFlag', () => {
    const runtime = makeRuntime({
      preferredFacade: 'cli',
      mcpPrefix: 'mcp__test__',
    });

    const outputTrue = renderCallMacros(
      '{{CALL exarchos_workflow cancel {"featureId":"X","dryRun":true}}}',
      runtime,
    );
    expect(outputTrue).toContain('--dry-run');
    expect(outputTrue).not.toMatch(/--dry-run\s+(true|false)/);

    const outputFalse = renderCallMacros(
      '{{CALL exarchos_workflow cancel {"featureId":"X","dryRun":false}}}',
      runtime,
    );
    expect(outputFalse).toContain('--no-dry-run');
  });

  /**
   * `String(value)` on an object gives `[object Object]`, so an object or array value must
   * render as JSON.
   */
  it('RenderCallMacro_CliFacade_ObjectArgsSerializeAsJson', () => {
    const runtime = makeRuntime({
      preferredFacade: 'cli',
      mcpPrefix: 'mcp__test__',
    });
    const output = renderCallMacros(
      '{{CALL exarchos_workflow set {"featureId":"X","updates":{"phase":"plan"}}}}',
      runtime,
    );
    expect(output).toContain('--updates {"phase":"plan"}');
    expect(output).not.toContain('[object Object]');
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

/**
 * Each rendered call ends with a one-line HTML comment that gives the same call in the other
 * facade. An agent can use that form when the primary facade is unavailable.
 */
describe('renderCallMacros — missing-facade remediation', () => {
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
        hasSkillChaining: true,
        mcpPrefix: overrides.mcpPrefix,
      },
      skillsInstallPath: '~/.test/skills',
      detection: { binaries: ['test'], envVars: ['TEST'] },
      placeholders: {},
    };
  }

  /** With the MCP facade, the fallback comment holds the CLI form of the call. */
  it('McpMissingAtRuntime_RenderedSkillEmitsActionableError', () => {
    const runtime = makeRuntime({
      preferredFacade: 'mcp',
      mcpPrefix: 'mcp__plugin_exarchos_exarchos__',
    });
    const input = '{{CALL exarchos_workflow set {"featureId":"X","phase":"plan"}}}';
    const output = renderCallMacros(input, runtime);

    expect(output).toContain('mcp__plugin_exarchos_exarchos__exarchos_workflow');

    expect(output).toContain('<!-- If MCP is unavailable');

    expect(output).toContain(
      'Bash(exarchos workflow set --feature-id X --phase plan --json)',
    );

    expect(output).toContain('-->');
  });

  /**
   * With the CLI facade, the fallback comment holds the MCP form, with the `action` field and
   * the args.
   */
  it('BashMissingAtRuntime_RenderedSkillEmitsActionableError', () => {
    const runtime = makeRuntime({
      preferredFacade: 'cli',
      mcpPrefix: 'mcp__plugin_exarchos_exarchos__',
    });
    const input = '{{CALL exarchos_workflow set {"featureId":"X","phase":"plan"}}}';
    const output = renderCallMacros(input, runtime);

    expect(output).toContain(
      'Bash(exarchos workflow set --feature-id X --phase plan --json)',
    );

    expect(output).toContain('<!-- If Bash is unavailable');

    expect(output).toContain('mcp__plugin_exarchos_exarchos__exarchos_workflow');

    expect(output).toMatch(/"action"\s*:\s*"set"/);
    expect(output).toMatch(/"featureId"\s*:\s*"X"/);
    expect(output).toMatch(/"phase"\s*:\s*"plan"/);

    expect(output).toContain('-->');
  });

  /** The open and close markers of the comment must be on one line. */
  it('McpFallback_SingleLineCommentForScanability', () => {
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

/**
 * The `beforeAll` hook wires the real registry lookup, so `validateCallMacro` can resolve the
 * action schemas. No hook clears it, so the lookup stays set for the later blocks of this file.
 */
describe('buildAllSkills — task 009: render-time CALL macro failures', () => {
  beforeAll(async () => {
    const buildSkills = await import('../../../src/install/build-skills.js');
    const registry = await import('../../../src/registry.js');
    buildSkills.setRegistryLookup(registry.findActionInRegistry);
  });

  /** The error names the skill source and the unknown action. */
  it('BuildAllSkills_CallMacroWithUnknownAction_FailsFast', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
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
    expect(err!.message).toContain('bad-action');
    expect(err!.message).toMatch(/unknown action.*NONEXISTENT_ACTION/i);
  });

  /** `transition` requires `featureId` and `target`, so empty args fail the schema. */
  it('BuildAllSkills_CallMacroArgsFailSchema_FailsFast', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    mkdirSync(join(srcDir, 'bad-args'), { recursive: true });
    writeFileSync(
      join(srcDir, 'bad-args', 'SKILL.md'),
      '{{CALL exarchos_workflow transition {}}}',
    );

    let err: Error | undefined;
    try {
      buildAllSkills({ srcDir, outDir, runtimesDir: REPO_RUNTIMES_DIR });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('bad-args');
    expect(err!.message).toMatch(/failed schema validation/i);
  });
});

/**
 * These tests cover the per-runtime token values, the runtime token coverage check, the
 * `<!-- requires:* -->` and `<!-- requires:native:* -->` guards, reference pruning, and a
 * repeated build. The fixtures are synthetic and do not read the real `content/` tree.
 * Each runtime fixture gets its `supportedCapabilities` map from `SUPPORTED_BY_RUNTIME`, so
 * the guard result differs by runtime. `FULL_PLACEHOLDERS` holds each token that a runtime
 * must declare.
 */
describe('buildAllSkills — Wave A: capability-aware prose renderer', () => {
  function makeWaveARuntimeYaml(
    name: string,
    placeholders: Record<string, string>,
    supportedCapabilities?: Record<string, 'native' | 'advisory'>,
  ): string {
    const escape = (s: string): string =>
      s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const placeholderLines =
      Object.keys(placeholders).length === 0
        ? '  {}'
        : Object.entries(placeholders)
            .map(([k, v]) => `  ${k}: "${escape(v)}"`)
            .join('\n');
    const lines: string[] = [
      `name: ${name}`,
      `preferredFacade: mcp`,
      `capabilities:`,
      `  hasSubagents: true`,
      `  hasSlashCommands: true`,
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
    ];
    if (supportedCapabilities) {
      lines.push('supportedCapabilities:');
      for (const [cap, level] of Object.entries(supportedCapabilities)) {
        lines.push(`  ${cap}: ${level}`);
      }
    }
    lines.push('');
    return lines.join('\n');
  }

  const FULL_PLACEHOLDERS: Record<string, string> = {
    MCP_PREFIX: 'mcp__test__',
    COMMAND_PREFIX: '/',
    TASK_TOOL: 'Task',
    CHAIN: '[Invoke {{next}} with {{args}}]',
    SPAWN_AGENT_CALL: 'Task({ prompt: "{{prompt}}" })',
    SUBAGENT_COMPLETION_HOOK: 'subagent completion signal (poll-based)',
    SUBAGENT_RESULT_API: '[poll subagent result]',
  };

  const SUPPORTED_BY_RUNTIME: Record<string, Record<string, 'native' | 'advisory'>> = {
    claude: {
      'fs:read': 'native',
      'fs:write': 'native',
      'shell:exec': 'native',
      'subagent:spawn': 'native',
      'subagent:completion-signal': 'native',
      'subagent:start-signal': 'native',
      'mcp:exarchos': 'native',
      'isolation:worktree': 'native',
      'team:agent-teams': 'native',
      'session:resume': 'native',
    },
    codex: {
      'fs:read': 'native',
      'fs:write': 'native',
      'shell:exec': 'native',
      'subagent:spawn': 'native',
      'mcp:exarchos': 'native',
      'isolation:worktree': 'advisory',
      'session:resume': 'advisory',
    },
    opencode: {
      'fs:read': 'native',
      'fs:write': 'native',
      'shell:exec': 'native',
      'subagent:spawn': 'native',
      'mcp:exarchos': 'native',
      'isolation:worktree': 'advisory',
      'session:resume': 'advisory',
    },
    cursor: {
      'fs:read': 'native',
      'fs:write': 'native',
      'shell:exec': 'native',
      'subagent:spawn': 'native',
      'mcp:exarchos': 'native',
      'isolation:worktree': 'advisory',
      'session:resume': 'advisory',
    },
    copilot: {
      'fs:read': 'native',
      'fs:write': 'native',
      'shell:exec': 'native',
      'subagent:spawn': 'native',
      'mcp:exarchos': 'native',
      'isolation:worktree': 'advisory',
      'session:resume': 'advisory',
    },
    generic: {
      'fs:read': 'native',
      'fs:write': 'native',
      'shell:exec': 'native',
    },
  };

  function writeWaveARuntimeFixtures(
    runtimesDir: string,
    perRuntimePlaceholders: Record<string, Record<string, string>>,
  ): void {
    mkdirSync(runtimesDir, { recursive: true });
    const names = ['generic', 'claude', 'codex', 'opencode', 'copilot', 'cursor'];
    for (const name of names) {
      writeFileSync(
        join(runtimesDir, `${name}.yaml`),
        makeWaveARuntimeYaml(
          name,
          perRuntimePlaceholders[name] ?? FULL_PLACEHOLDERS,
          SUPPORTED_BY_RUNTIME[name],
        ),
      );
    }
  }

  it('BuildSkills_SubagentCompletionHookToken_RendersPerRuntime', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      'Wait via {{SUBAGENT_COMPLETION_HOOK}} on this runtime.',
    );

    const claudePh = { ...FULL_PLACEHOLDERS, SUBAGENT_COMPLETION_HOOK: 'TeammateIdle hook' };
    const codexPh = {
      ...FULL_PLACEHOLDERS,
      SUBAGENT_COMPLETION_HOOK: 'subagent completion signal (poll-based)',
    };
    writeWaveARuntimeFixtures(runtimesDir, {
      claude: claudePh,
      codex: codexPh,
      opencode: codexPh,
      cursor: codexPh,
      copilot: codexPh,
      generic: codexPh,
    });

    buildAllSkills({ srcDir, outDir, runtimesDir });

    const claudeOut = readFileSync(join(outDir, 'claude', 'foo', 'SKILL.md'), 'utf8');
    expect(claudeOut).toContain('TeammateIdle hook');
    const codexOut = readFileSync(join(outDir, 'codex', 'foo', 'SKILL.md'), 'utf8');
    expect(codexOut).toContain('subagent completion signal (poll-based)');
    expect(codexOut).not.toContain('TeammateIdle');
  });

  it('BuildSkills_SubagentResultApiToken_RendersPerRuntime', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      'Collect results via {{SUBAGENT_RESULT_API}}',
    );

    const claudePh = {
      ...FULL_PLACEHOLDERS,
      SUBAGENT_RESULT_API: 'TaskOutput({ task_id, block: true })',
    };
    const codexPh = {
      ...FULL_PLACEHOLDERS,
      SUBAGENT_RESULT_API: 'wait_agent({ task_id })',
    };
    const copilotPh = {
      ...FULL_PLACEHOLDERS,
      SUBAGENT_RESULT_API: '`task` output (inline)',
    };
    writeWaveARuntimeFixtures(runtimesDir, {
      claude: claudePh,
      codex: codexPh,
      opencode: codexPh,
      cursor: codexPh,
      copilot: copilotPh,
      generic: codexPh,
    });

    buildAllSkills({ srcDir, outDir, runtimesDir });

    expect(readFileSync(join(outDir, 'claude', 'foo', 'SKILL.md'), 'utf8')).toContain(
      'TaskOutput({ task_id, block: true })',
    );
    expect(readFileSync(join(outDir, 'codex', 'foo', 'SKILL.md'), 'utf8')).toContain(
      'wait_agent({ task_id })',
    );
    expect(readFileSync(join(outDir, 'copilot', 'foo', 'SKILL.md'), 'utf8')).toContain(
      '`task` output (inline)',
    );
  });

  /**
   * The `codex` fixture omits `SUBAGENT_COMPLETION_HOOK`. The coverage error must name the
   * runtime and the token.
   */
  it('BuildSkills_TokenWithoutDefinition_FailsBuild', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      'Use {{SUBAGENT_COMPLETION_HOOK}}.',
    );

    const incompletePh = { ...FULL_PLACEHOLDERS };
    delete incompletePh.SUBAGENT_COMPLETION_HOOK;

    writeWaveARuntimeFixtures(runtimesDir, {
      codex: incompletePh,
    });

    let err: Error | undefined;
    try {
      buildAllSkills({ srcDir, outDir, runtimesDir });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('SUBAGENT_COMPLETION_HOOK');
    expect(err!.message).toContain('codex');
  });

  /**
   * Claude declares `team:agent-teams` and OpenCode does not, so only the Claude render keeps
   * the section. The guard markers never reach the output.
   */
  it('BuildSkills_RequiresGuard_ElidesUnsupportedSection', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      [
        '# Foo',
        '',
        'Always-rendered intro. {{TASK_TOOL}}',
        '',
        '<!-- requires:team:agent-teams -->',
        '## Agent Teams Section',
        'This is Claude-only content.',
        '<!-- /requires -->',
        '',
        'Always-rendered outro.',
        '',
      ].join('\n'),
    );
    writeWaveARuntimeFixtures(runtimesDir, {});

    buildAllSkills({ srcDir, outDir, runtimesDir });

    const claudeOut = readFileSync(join(outDir, 'claude', 'foo', 'SKILL.md'), 'utf8');
    expect(claudeOut).toContain('Agent Teams Section');
    expect(claudeOut).toContain('Claude-only content');
    expect(claudeOut).not.toContain('<!-- requires:');
    expect(claudeOut).not.toContain('<!-- /requires -->');

    const opencodeOut = readFileSync(
      join(outDir, 'opencode', 'foo', 'SKILL.md'),
      'utf8',
    );
    expect(opencodeOut).not.toContain('Agent Teams Section');
    expect(opencodeOut).not.toContain('Claude-only content');
    expect(opencodeOut).toContain('Always-rendered intro.');
    expect(opencodeOut).toContain('Always-rendered outro.');
  });

  /**
   * Claude declares `session:resume` as `native` and keeps the block. The four runtimes that
   * declare it as `advisory` lose the block.
   */
  it('BuildSkills_RequiresNativeGuard_AdvisoryRuntimeElides', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      [
        'intro {{TASK_TOOL}}',
        '<!-- requires:native:session:resume -->',
        'native-only resume strategy block',
        '<!-- /requires -->',
        'outro',
      ].join('\n'),
    );
    writeWaveARuntimeFixtures(runtimesDir, {});

    buildAllSkills({ srcDir, outDir, runtimesDir });

    const claudeOut = readFileSync(join(outDir, 'claude', 'foo', 'SKILL.md'), 'utf8');
    expect(claudeOut).toContain('native-only resume strategy block');

    for (const rt of ['opencode', 'cursor', 'codex', 'copilot']) {
      const out = readFileSync(join(outDir, rt, 'foo', 'SKILL.md'), 'utf8');
      expect(out).not.toContain('native-only resume strategy block');
      expect(out).toContain('intro');
      expect(out).toContain('outro');
    }
  });

  /**
   * The error names the capability, the source file, and line 2, the 1-indexed line of the
   * open guard.
   */
  it('BuildSkills_UnknownGuardCapability_FailsBuild', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      [
        'intro {{TASK_TOOL}}',
        '<!-- requires:not-a-real-cap -->',
        'body',
        '<!-- /requires -->',
        'outro',
      ].join('\n'),
    );
    writeWaveARuntimeFixtures(runtimesDir, {});

    let err: Error | undefined;
    try {
      buildAllSkills({ srcDir, outDir, runtimesDir });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('not-a-real-cap');
    expect(err!.message).toMatch(/SKILL\.md/);
    expect(err!.message).toMatch(/:2/);
  });

  /**
   * A failed outer guard removes its whole block. That includes an inner block whose own
   * capability the runtime has.
   */
  it('BuildSkills_NestedGuards_Respected', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      [
        'intro {{TASK_TOOL}}',
        '<!-- requires:team:agent-teams -->',
        'outer body',
        '<!-- requires:fs:read -->',
        'inner body that would otherwise survive',
        '<!-- /requires -->',
        'outer trailer',
        '<!-- /requires -->',
        'outro',
      ].join('\n'),
    );
    writeWaveARuntimeFixtures(runtimesDir, {});

    buildAllSkills({ srcDir, outDir, runtimesDir });

    const opencodeOut = readFileSync(
      join(outDir, 'opencode', 'foo', 'SKILL.md'),
      'utf8',
    );
    expect(opencodeOut).not.toContain('outer body');
    expect(opencodeOut).not.toContain('inner body');
    expect(opencodeOut).not.toContain('outer trailer');
    expect(opencodeOut).toContain('intro');
    expect(opencodeOut).toContain('outro');

    const claudeOut = readFileSync(join(outDir, 'claude', 'foo', 'SKILL.md'), 'utf8');
    expect(claudeOut).toContain('outer body');
    expect(claudeOut).toContain('inner body that would otherwise survive');
    expect(claudeOut).toContain('outer trailer');
  });

  /**
   * The link to `references/foo.md` is inside a `team:agent-teams` guard. OpenCode elides the
   * link, so its output has no `foo.md`.
   */
  it('BuildSkills_OrphanReferenceFile_NotCopied', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo', 'references'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      [
        '# Foo {{TASK_TOOL}}',
        '<!-- requires:team:agent-teams -->',
        'See [foo](references/foo.md) for details.',
        '<!-- /requires -->',
        'See [bar](references/bar.md) always.',
      ].join('\n'),
    );
    writeFileSync(join(srcDir, 'foo', 'references', 'foo.md'), 'foo content');
    writeFileSync(join(srcDir, 'foo', 'references', 'bar.md'), 'bar content');
    writeWaveARuntimeFixtures(runtimesDir, {});

    buildAllSkills({ srcDir, outDir, runtimesDir });

    expect(existsSync(join(outDir, 'claude', 'foo', 'references', 'foo.md'))).toBe(true);
    expect(existsSync(join(outDir, 'claude', 'foo', 'references', 'bar.md'))).toBe(true);
    expect(existsSync(join(outDir, 'opencode', 'foo', 'references', 'foo.md'))).toBe(
      false,
    );
    expect(existsSync(join(outDir, 'opencode', 'foo', 'references', 'bar.md'))).toBe(
      true,
    );
  });

  /** A second build must give the same files with the same bytes. */
  it('BuildSkills_RenderIdempotent', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo', 'references'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      [
        '# Foo {{TASK_TOOL}}',
        '<!-- requires:team:agent-teams -->',
        'agent teams',
        '<!-- /requires -->',
        'See [bar](references/bar.md).',
      ].join('\n'),
    );
    writeFileSync(join(srcDir, 'foo', 'references', 'bar.md'), 'bar');
    writeWaveARuntimeFixtures(runtimesDir, {});

    buildAllSkills({ srcDir, outDir, runtimesDir });

    const snapshot = new Map<string, Buffer>();
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      const { readdirSync: rds, statSync: sts } = require('node:fs') as typeof import('node:fs');
      for (const entry of rds(dir)) {
        const full = join(dir, entry);
        const st = sts(full);
        if (st.isDirectory()) walk(full);
        else if (st.isFile()) snapshot.set(full, readFileSync(full));
      }
    };
    walk(outDir);

    buildAllSkills({ srcDir, outDir, runtimesDir });

    const snapshot2 = new Map<string, Buffer>();
    walk2: {
      const stack: string[] = [outDir];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (!existsSync(cur)) continue;
        for (const entry of (require('node:fs') as typeof import('node:fs')).readdirSync(
          cur,
        )) {
          const full = join(cur, entry);
          const st = (require('node:fs') as typeof import('node:fs')).statSync(full);
          if (st.isDirectory()) stack.push(full);
          else if (st.isFile()) snapshot2.set(full, readFileSync(full));
        }
      }
      break walk2;
    }

    expect(snapshot2.size).toBe(snapshot.size);
    for (const [path, bytes] of snapshot.entries()) {
      const after = snapshot2.get(path);
      expect(after, `missing after rebuild: ${path}`).toBeDefined();
      expect(
        after!.equals(bytes),
        `byte mismatch on ${path}`,
      ).toBe(true);
    }
  });
});

/**
 * The lint reads each rendered SKILL.md and fails the build on a Claude-only term in a render
 * for another runtime. A runtime that declares `team:agent-teams: native` is exempt, and in the
 * fixtures only Claude does. A `runtime:claude-only` code block never reaches a non-Claude
 * render. A capability identifier such as `team:agent-teams` is not a forbidden term.
 * The loader requires all six runtime files, and the tests read only the `claude` and
 * `opencode` output.
 */
describe('buildAllSkills — Wave B: post-render vocabulary lint', () => {
  const FULL_PLACEHOLDERS_B: Record<string, string> = {
    MCP_PREFIX: 'mcp__test__',
    COMMAND_PREFIX: '/',
    TASK_TOOL: 'Task',
    CHAIN: '[Invoke {{next}} with {{args}}]',
    SPAWN_AGENT_CALL: 'Task({ prompt: "{{prompt}}" })',
    SUBAGENT_COMPLETION_HOOK: 'subagent completion signal (poll-based)',
    SUBAGENT_RESULT_API: '[poll subagent result]',
  };

  const NON_CLAUDE_CAPS: Record<string, 'native' | 'advisory'> = {
    'fs:read': 'native',
    'fs:write': 'native',
    'shell:exec': 'native',
    'subagent:spawn': 'native',
    'mcp:exarchos': 'native',
    'isolation:worktree': 'advisory',
    'session:resume': 'advisory',
  };
  const SUPPORTED_BY_RUNTIME_B: Record<
    string,
    Record<string, 'native' | 'advisory'>
  > = {
    claude: {
      'fs:read': 'native',
      'fs:write': 'native',
      'shell:exec': 'native',
      'subagent:spawn': 'native',
      'subagent:completion-signal': 'native',
      'subagent:start-signal': 'native',
      'mcp:exarchos': 'native',
      'isolation:worktree': 'native',
      'team:agent-teams': 'native',
      'session:resume': 'native',
    },
    opencode: NON_CLAUDE_CAPS,
    codex: NON_CLAUDE_CAPS,
    cursor: NON_CLAUDE_CAPS,
    copilot: NON_CLAUDE_CAPS,
    generic: {
      'fs:read': 'native',
      'fs:write': 'native',
      'shell:exec': 'native',
    },
  };

  function makeWaveBRuntimeYaml(
    name: string,
    placeholders: Record<string, string>,
    supportedCapabilities: Record<string, 'native' | 'advisory'>,
  ): string {
    const escape = (s: string): string =>
      s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const placeholderLines = Object.entries(placeholders)
      .map(([k, v]) => `  ${k}: "${escape(v)}"`)
      .join('\n');
    const lines: string[] = [
      `name: ${name}`,
      `preferredFacade: mcp`,
      `capabilities:`,
      `  hasSubagents: true`,
      `  hasSlashCommands: true`,
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
      'supportedCapabilities:',
    ];
    for (const [cap, level] of Object.entries(supportedCapabilities)) {
      lines.push(`  ${cap}: ${level}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  function writeWaveBRuntimeFixtures(runtimesDir: string): void {
    mkdirSync(runtimesDir, { recursive: true });
    const names = ['generic', 'claude', 'codex', 'opencode', 'copilot', 'cursor'];
    for (const name of names) {
      writeFileSync(
        join(runtimesDir, `${name}.yaml`),
        makeWaveBRuntimeYaml(
          name,
          FULL_PLACEHOLDERS_B,
          SUPPORTED_BY_RUNTIME_B[name],
        ),
      );
    }
  }

  /**
   * `TaskList` is inside a `team:agent-teams` guard. The Claude render keeps it and is exempt,
   * and the OpenCode render elides it.
   */
  it('VocabularyLint_ForbiddenTermInClaudeRenderInsideRequiresGuard_Passes', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      [
        '# Foo {{TASK_TOOL}}',
        '<!-- requires:team:agent-teams -->',
        'uses TaskList for coordination',
        '<!-- /requires -->',
        'always-on outro',
      ].join('\n'),
    );
    writeWaveBRuntimeFixtures(runtimesDir);

    expect(() => buildAllSkills({ srcDir, outDir, runtimesDir })).not.toThrow();

    const claudeOut = readFileSync(join(outDir, 'claude', 'foo', 'SKILL.md'), 'utf8');
    expect(claudeOut).toContain('TaskList');
    const opencodeOut = readFileSync(
      join(outDir, 'opencode', 'foo', 'SKILL.md'),
      'utf8',
    );
    expect(opencodeOut).not.toContain('TaskList');
  });

  /**
   * `TaskOutput` is in no guard and in no code block, so it reaches the OpenCode render.
   * The error names the term, the runtime, the source path, line 5, and a remediation.
   */
  it('VocabularyLint_ForbiddenTermInOpenCodeRender_FailsCI', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      [
        '# Foo {{TASK_TOOL}}',
        '',
        'always-on intro',
        '',
        'TaskOutput({ task_id: x, block: true }) // raw call in prose',
        '',
        'always-on outro',
      ].join('\n'),
    );
    writeWaveBRuntimeFixtures(runtimesDir);

    let err: Error | undefined;
    try {
      buildAllSkills({ srcDir, outDir, runtimesDir });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('TaskOutput');
    expect(err!.message).toContain('opencode');
    expect(err!.message).toMatch(/foo\/SKILL\.md/);
    expect(err!.message).toMatch(/:5/);
    expect(err!.message).toMatch(/requires:|runtime:claude-only/);
  });

  /**
   * The Claude render keeps the `runtime:claude-only` snippet. The OpenCode render loses the
   * block and its info string, so the lint finds no term.
   */
  it('VocabularyLint_RuntimeClaudeOnlyCodeBlock_ElidedFromNonClaudeRender', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      [
        '# Foo {{TASK_TOOL}}',
        '',
        'always-on intro',
        '',
        '```ts runtime:claude-only',
        'TaskOutput({ task_id: x, block: true })',
        '```',
        '',
        'always-on outro',
      ].join('\n'),
    );
    writeWaveBRuntimeFixtures(runtimesDir);

    expect(() => buildAllSkills({ srcDir, outDir, runtimesDir })).not.toThrow();

    const claudeOut = readFileSync(join(outDir, 'claude', 'foo', 'SKILL.md'), 'utf8');
    expect(claudeOut).toContain('TaskOutput({ task_id: x, block: true })');

    const opencodeOut = readFileSync(
      join(outDir, 'opencode', 'foo', 'SKILL.md'),
      'utf8',
    );
    expect(opencodeOut).not.toContain('TaskOutput');
    expect(opencodeOut).not.toContain('runtime:claude-only');
    expect(opencodeOut).toContain('always-on intro');
    expect(opencodeOut).toContain('always-on outro');
  });

  /**
   * The forbidden list does not hold `agent-teams`. Thus the capability identifier
   * `team:agent-teams` in an OpenCode render passes the lint.
   */
  it('VocabularyLint_CapabilityIdentifierNotFlagged', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      [
        '# Foo {{TASK_TOOL}}',
        '',
        'Capabilities map snippet:',
        '',
        '```yaml',
        'supportedCapabilities:',
        '  team:agent-teams: native',
        '```',
        '',
        'outro',
      ].join('\n'),
    );
    writeWaveBRuntimeFixtures(runtimesDir);

    expect(() => buildAllSkills({ srcDir, outDir, runtimesDir })).not.toThrow();

    const opencodeOut = readFileSync(
      join(outDir, 'opencode', 'foo', 'SKILL.md'),
      'utf8',
    );
    expect(opencodeOut).toContain('team:agent-teams');
  });
});

/**
 * A linked Markdown reference goes through the same pipeline as SKILL.md: token expansion,
 * guard elision, Claude-only block elision, and the vocabulary lint. A byte-for-byte copy of
 * a reference lets Claude-only prose reach the other runtimes.
 */
describe('buildAllSkills — Wave C: reference rendering + lint', () => {
  const FULL_PLACEHOLDERS_C: Record<string, string> = {
    MCP_PREFIX: 'mcp__test__',
    COMMAND_PREFIX: '/',
    TASK_TOOL: 'Task',
    CHAIN: '[Invoke {{next}} with {{args}}]',
    SPAWN_AGENT_CALL: 'Task({ prompt: "{{prompt}}" })',
    SUBAGENT_COMPLETION_HOOK: 'subagent completion signal (poll-based)',
    SUBAGENT_RESULT_API: '[poll subagent result]',
  };

  const NON_CLAUDE_CAPS_C: Record<string, 'native' | 'advisory'> = {
    'fs:read': 'native',
    'fs:write': 'native',
    'shell:exec': 'native',
    'subagent:spawn': 'native',
    'mcp:exarchos': 'native',
    'isolation:worktree': 'advisory',
    'session:resume': 'advisory',
  };

  const SUPPORTED_BY_RUNTIME_C: Record<
    string,
    Record<string, 'native' | 'advisory'>
  > = {
    claude: {
      'fs:read': 'native',
      'fs:write': 'native',
      'shell:exec': 'native',
      'subagent:spawn': 'native',
      'subagent:completion-signal': 'native',
      'subagent:start-signal': 'native',
      'mcp:exarchos': 'native',
      'isolation:worktree': 'native',
      'team:agent-teams': 'native',
      'session:resume': 'native',
    },
    opencode: NON_CLAUDE_CAPS_C,
    codex: NON_CLAUDE_CAPS_C,
    cursor: NON_CLAUDE_CAPS_C,
    copilot: NON_CLAUDE_CAPS_C,
    generic: {
      'fs:read': 'native',
      'fs:write': 'native',
      'shell:exec': 'native',
    },
  };

  function makeWaveCRuntimeYaml(
    name: string,
    placeholders: Record<string, string>,
    supportedCapabilities: Record<string, 'native' | 'advisory'>,
  ): string {
    const escape = (s: string): string =>
      s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const placeholderLines = Object.entries(placeholders)
      .map(([k, v]) => `  ${k}: "${escape(v)}"`)
      .join('\n');
    const lines: string[] = [
      `name: ${name}`,
      `preferredFacade: mcp`,
      `capabilities:`,
      `  hasSubagents: true`,
      `  hasSlashCommands: true`,
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
      'supportedCapabilities:',
    ];
    for (const [cap, level] of Object.entries(supportedCapabilities)) {
      lines.push(`  ${cap}: ${level}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  function writeWaveCRuntimeFixtures(
    runtimesDir: string,
    perRuntimePlaceholders: Record<string, Record<string, string>> = {},
  ): void {
    mkdirSync(runtimesDir, { recursive: true });
    const names = ['generic', 'claude', 'codex', 'opencode', 'copilot', 'cursor'];
    for (const name of names) {
      writeFileSync(
        join(runtimesDir, `${name}.yaml`),
        makeWaveCRuntimeYaml(
          name,
          perRuntimePlaceholders[name] ?? FULL_PLACEHOLDERS_C,
          SUPPORTED_BY_RUNTIME_C[name],
        ),
      );
    }
  }

  /**
   * Each rendered reference must hold the token value of its runtime, not the literal token.
   * The Claude value must not reach the OpenCode reference.
   */
  it('BuildSkills_ReferenceFile_TokenExpansion_RendersPerRuntime', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo', 'references'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      ['# Foo {{TASK_TOOL}}', 'See [foo](references/foo.md) for details.'].join('\n'),
    );
    writeFileSync(
      join(srcDir, 'foo', 'references', 'foo.md'),
      'See {{SUBAGENT_COMPLETION_HOOK}} for details.',
    );

    const claudePh = {
      ...FULL_PLACEHOLDERS_C,
      SUBAGENT_COMPLETION_HOOK: 'TeammateIdle hook',
    };
    const nonClaudePh = {
      ...FULL_PLACEHOLDERS_C,
      SUBAGENT_COMPLETION_HOOK: 'subagent completion signal (poll-based)',
    };
    writeWaveCRuntimeFixtures(runtimesDir, {
      claude: claudePh,
      codex: nonClaudePh,
      opencode: nonClaudePh,
      cursor: nonClaudePh,
      copilot: nonClaudePh,
      generic: nonClaudePh,
    });

    buildAllSkills({ srcDir, outDir, runtimesDir });

    const claudeRef = readFileSync(
      join(outDir, 'claude', 'foo', 'references', 'foo.md'),
      'utf8',
    );
    expect(claudeRef).toContain('TeammateIdle hook');
    expect(claudeRef).not.toContain('{{SUBAGENT_COMPLETION_HOOK}}');

    const opencodeRef = readFileSync(
      join(outDir, 'opencode', 'foo', 'references', 'foo.md'),
      'utf8',
    );
    expect(opencodeRef).toContain('subagent completion signal (poll-based)');
    expect(opencodeRef).not.toContain('{{SUBAGENT_COMPLETION_HOOK}}');
    expect(opencodeRef).not.toContain('TeammateIdle');
  });

  /**
   * A guard in a reference body works as it does in SKILL.md. The guard markers never reach
   * the output.
   */
  it('BuildSkills_ReferenceFile_RequiresGuard_ElidesUnsupportedSection', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo', 'references'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      ['# Foo {{TASK_TOOL}}', 'See [foo](references/foo.md) for details.'].join('\n'),
    );
    writeFileSync(
      join(srcDir, 'foo', 'references', 'foo.md'),
      [
        'always-on intro',
        '<!-- requires:team:agent-teams -->',
        'TeamCreate is here',
        '<!-- /requires -->',
        'always-on outro',
      ].join('\n'),
    );
    writeWaveCRuntimeFixtures(runtimesDir);

    buildAllSkills({ srcDir, outDir, runtimesDir });

    const claudeRef = readFileSync(
      join(outDir, 'claude', 'foo', 'references', 'foo.md'),
      'utf8',
    );
    expect(claudeRef).toContain('TeamCreate is here');
    expect(claudeRef).not.toContain('<!-- requires:');
    expect(claudeRef).not.toContain('<!-- /requires -->');

    const opencodeRef = readFileSync(
      join(outDir, 'opencode', 'foo', 'references', 'foo.md'),
      'utf8',
    );
    expect(opencodeRef).not.toContain('TeamCreate');
    expect(opencodeRef).toContain('always-on intro');
    expect(opencodeRef).toContain('always-on outro');
  });

  /**
   * A `runtime:claude-only` block in a reference stays in the Claude render. The OpenCode
   * render loses the block and its info string.
   */
  it('BuildSkills_ReferenceFile_RuntimeClaudeOnlyCodeBlock_Elided', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo', 'references'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      ['# Foo {{TASK_TOOL}}', 'See [foo](references/foo.md) for details.'].join('\n'),
    );
    writeFileSync(
      join(srcDir, 'foo', 'references', 'foo.md'),
      [
        'always-on intro',
        '',
        '```ts runtime:claude-only',
        'TaskOutput({ task_id: x, block: true })',
        '```',
        '',
        'always-on outro',
      ].join('\n'),
    );
    writeWaveCRuntimeFixtures(runtimesDir);

    buildAllSkills({ srcDir, outDir, runtimesDir });

    const claudeRef = readFileSync(
      join(outDir, 'claude', 'foo', 'references', 'foo.md'),
      'utf8',
    );
    expect(claudeRef).toContain('TaskOutput({ task_id: x, block: true })');

    const opencodeRef = readFileSync(
      join(outDir, 'opencode', 'foo', 'references', 'foo.md'),
      'utf8',
    );
    expect(opencodeRef).not.toContain('TaskOutput');
    expect(opencodeRef).not.toContain('runtime:claude-only');
    expect(opencodeRef).toContain('always-on intro');
    expect(opencodeRef).toContain('always-on outro');
  });

  /**
   * The term is on line 3 of `references/bad.md`. The error must name that file and line,
   * not SKILL.md.
   */
  it('VocabularyLint_ForbiddenTermInReferenceFile_FailsCI', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'foo', 'references'), { recursive: true });
    writeFileSync(
      join(srcDir, 'foo', 'SKILL.md'),
      ['# Foo {{TASK_TOOL}}', 'See [bad](references/bad.md).'].join('\n'),
    );
    writeFileSync(
      join(srcDir, 'foo', 'references', 'bad.md'),
      [
        'always-on intro',
        '',
        'uses TaskList for coordination',
        '',
        'always-on outro',
      ].join('\n'),
    );
    writeWaveCRuntimeFixtures(runtimesDir);

    let err: Error | undefined;
    try {
      buildAllSkills({ srcDir, outDir, runtimesDir });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('TaskList');
    expect(err!.message).toContain('opencode');
    expect(err!.message).toMatch(/references\/bad\.md/);
    expect(err!.message).not.toMatch(/foo\/SKILL\.md:/);
    expect(err!.message).toMatch(/:3/);
    expect(err!.message).toMatch(/requires:|runtime:claude-only/);
  });

  /**
   * Builds the real `content/` tree with the real runtime YAML files. A Claude-only term in a
   * render for another runtime fails this test.
   */
  it('VocabularyLint_RealDelegationReferences_AllRuntimesPass', () => {
    const REPO_SRC_DIR = resolve(__dirname, '../../../content');
    const REPO_RUNTIMES_DIR_C = resolve(__dirname, '../../../content/harness/runtimes');
    const root = makeTempDir();
    const outDir = join(root, 'skills-out');

    expect(() =>
      buildAllSkills({
        srcDir: REPO_SRC_DIR,
        outDir,
        runtimesDir: REPO_RUNTIMES_DIR_C,
      }),
    ).not.toThrow();
  });
});

/**
 * `classifySkill` derives the class from only the canonical placeholder tokens of a source.
 * An orchestration token makes the skill `orchestration`, and each other source is `procedural`.
 * `assertProceduralSkill` rejects an orchestration token or a `<!-- requires:* -->` guard.
 * A procedural skill has one render, so neither construct can vary by runtime in it.
 */
describe('classifySkill — task 001: procedural vs orchestration', () => {
  /**
   * The model records only the two prefix tokens. It ignores the handlebar literal `{{next}}`
   * and the non-canonical `{{AGENT_LABEL}}`.
   */
  it('classifySkill_PrefixOnlySource_ClassifiedProcedural', () => {
    const body = [
      '# Foo',
      'Invoke it via {{MCP_PREFIX}}exarchos_workflow and {{COMMAND_PREFIX}}plan.',
      'Also a handlebar literal {{next}} and a non-canonical {{AGENT_LABEL}}.',
    ].join('\n');

    const model = classifySkill(body);

    expect(model.skillClass).toBe('procedural');
    expect([...model.tokensUsed].sort()).toEqual(['COMMAND_PREFIX', 'MCP_PREFIX']);
    expect(model.orchestrationTokensUsed.size).toBe(0);
    expect(model.hasCapabilityGuard).toBe(false);
  });

  it('classifySkill_NoTokens_ClassifiedProcedural', () => {
    const model = classifySkill('# Plain\nNo placeholders here.');
    expect(model.skillClass).toBe('procedural');
    expect(model.tokensUsed.size).toBe(0);
  });

  /** One orchestration token sets the class, and a prefix token beside it does not change that. */
  it('classifySkill_OrchestrationToken_ClassifiedOrchestration', () => {
    const body =
      'Spawn with {{SPAWN_AGENT_CALL agent="foo"}} and chain {{CHAIN next="plan"}}; prefix {{MCP_PREFIX}}.';
    const model = classifySkill(body);
    expect(model.skillClass).toBe('orchestration');
    expect([...model.orchestrationTokensUsed].sort()).toEqual([
      'CHAIN',
      'SPAWN_AGENT_CALL',
    ]);
  });

  /** The test calls `assertProceduralSkill` directly on a source that holds `{{TASK_TOOL}}`. */
  it('classifySkill_ProceduralSourceWithOrchestrationToken_FailsBuild', () => {
    const body =
      'Prefix {{MCP_PREFIX}}exarchos_workflow, but also {{TASK_TOOL}} for spawning.';
    let err: Error | undefined;
    try {
      assertProceduralSkill(body, 'content/foo/SKILL.md');
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/orchestration token/i);
    expect(err!.message).toContain('TASK_TOOL');
    expect(err!.message).toContain('content/foo/SKILL.md');
  });

  /**
   * A guard is not a token, so it does not change the class. The assertion still rejects a
   * guard in a procedural source.
   */
  it('classifySkill_RequiresBlockInProceduralSource_FailsBuild', () => {
    const body = [
      'intro',
      '<!-- requires:team:agent-teams -->',
      'agent-teams-only content',
      '<!-- /requires -->',
      'outro',
    ].join('\n');

    expect(classifySkill(body).skillClass).toBe('procedural');
    expect(classifySkill(body).hasCapabilityGuard).toBe(true);

    let err: Error | undefined;
    try {
      assertProceduralSkill(body, 'content/bar/SKILL.md');
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/requires|capability guard/i);
    expect(err!.message).toContain('content/bar/SKILL.md');
  });

  it('assertProceduralSkill_CleanProceduralSource_DoesNotThrow', () => {
    const body = 'Use {{MCP_PREFIX}}exarchos_view and {{COMMAND_PREFIX}}review.';
    expect(() =>
      assertProceduralSkill(body, 'content/ok/SKILL.md'),
    ).not.toThrow();
  });

  it('ORCHESTRATION_TOKENS_ExcludePrefixTokens', () => {
    expect(ORCHESTRATION_TOKENS.has('MCP_PREFIX')).toBe(false);
    expect(ORCHESTRATION_TOKENS.has('COMMAND_PREFIX')).toBe(false);
    for (const t of [
      'TASK_TOOL',
      'CHAIN',
      'SPAWN_AGENT_CALL',
      'SUBAGENT_COMPLETION_HOOK',
      'SUBAGENT_RESULT_API',
    ] as const) {
      expect(ORCHESTRATION_TOKENS.has(t)).toBe(true);
    }
    expect(PREFIX_TOKENS.has('MCP_PREFIX')).toBe(true);
    expect(PREFIX_TOKENS.has('COMMAND_PREFIX')).toBe(true);
  });
});

/**
 * `RuntimeTokenKey` holds the two prefix tokens, so each runtime YAML must declare them.
 * Orchestration sources under `content/` still use them.
 */
describe('assertRuntimeTokenCoverage — task 002 (prefix retention)', () => {
  function makeCoverageRuntime(
    placeholders: Record<string, string>,
  ): RuntimeMap {
    return {
      name: 'coverage-test',
      preferredFacade: 'mcp',
      capabilities: {
        hasSubagents: true,
        hasSlashCommands: true,
        hasSkillChaining: true,
        mcpPrefix: 'mcp__test__',
      },
      skillsInstallPath: '~/.test/skills',
      detection: { binaries: ['test'], envVars: ['TEST'] },
      placeholders,
    };
  }

  /**
   * A runtime with each canonical token passes. A runtime without the two prefix tokens fails,
   * and the error names both.
   */
  it('assertRuntimeTokenCoverage_PrefixTokensStillConsumed_Required', () => {
    const full: Record<string, string> = {};
    for (const token of RuntimeTokenKey) full[token] = 'x';
    expect(() =>
      assertRuntimeTokenCoverage([makeCoverageRuntime(full)]),
    ).not.toThrow();

    const missingPrefixes: Record<string, string> = {};
    for (const token of RuntimeTokenKey) {
      if (token === 'MCP_PREFIX' || token === 'COMMAND_PREFIX') continue;
      missingPrefixes[token] = 'x';
    }
    let err: unknown;
    try {
      assertRuntimeTokenCoverage([makeCoverageRuntime(missingPrefixes)]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('MCP_PREFIX');
    expect(message).toContain('COMMAND_PREFIX');
  });
});

/** Git identity for the commits that the drift test makes in a temp repository. */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const ALL_RUNTIME_NAMES = ['generic', 'claude', 'codex', 'opencode', 'copilot', 'cursor'];

/**
 * A procedural skill renders once to `standard/<skill>`. An orchestration skill renders once
 * for each runtime, to `<runtime>/<skill>`. A `{{CHAIN next="..."}}` token fails the build
 * when its target is not a canonical verb and not a skill on disk.
 */
describe('buildAllSkills — task 003: classification-driven emission', () => {
  /**
   * The source holds no token, so it is procedural and passes the collapsed-vocabulary lint.
   * Its text already has the logical form `exarchos:exarchos_workflow`, and the render keeps it.
   * The linked reference goes to the `standard` variant, and no runtime tree gets the skill.
   */
  it('buildAllSkills_ProceduralSkill_EmitsSingleStandardVariant', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'proc'), { recursive: true });
    writeFileSync(
      join(srcDir, 'proc', 'SKILL.md'),
      'Call exarchos:exarchos_workflow; then run review — see [note](references/note.md).\n',
    );
    mkdirSync(join(srcDir, 'proc', 'references'), { recursive: true });
    writeFileSync(join(srcDir, 'proc', 'references', 'note.md'), 'a shared reference');
    writeRuntimeFixtures(runtimesDir);

    const report = buildAllSkills({ srcDir, outDir, runtimesDir });

    const standardFile = join(outDir, 'standard', 'proc', 'SKILL.md');
    expect(existsSync(standardFile)).toBe(true);
    const rendered = readFileSync(standardFile, 'utf8');
    expect(rendered).toContain('exarchos:exarchos_workflow');
    expect(rendered).toContain('run review —');
    expect(rendered).not.toContain('mcp__');
    expect(
      readFileSync(join(outDir, 'standard', 'proc', 'references', 'note.md'), 'utf8'),
    ).toBe('a shared reference');

    for (const rt of ALL_RUNTIME_NAMES) {
      expect(existsSync(join(outDir, rt, 'proc', 'SKILL.md'))).toBe(false);
    }
    expect(report.variantsWritten).toBe(1);
  });

  it('buildAllSkills_OrchestrationSkill_EmitsPerRuntimeVariants', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'orch'), { recursive: true });
    writeFileSync(
      join(srcDir, 'orch', 'SKILL.md'),
      'Spawn a subagent with {{TASK_TOOL}} to fan out the work.\n',
    );
    writeRuntimeFixtures(runtimesDir);

    const report = buildAllSkills({ srcDir, outDir, runtimesDir });

    for (const rt of ALL_RUNTIME_NAMES) {
      expect(existsSync(join(outDir, rt, 'orch', 'SKILL.md'))).toBe(true);
    }
    expect(existsSync(join(outDir, 'standard', 'orch', 'SKILL.md'))).toBe(false);
    expect(report.variantsWritten).toBe(6);
  });

  /**
   * The test commits a hand edit to the rendered `standard` file. The guard builds the file
   * again, so `git diff` reports the drift, and the message names the file.
   */
  it('skillsGuard_StandardTreeDrift_Fails', async () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'rendered', 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'proc'), { recursive: true });
    writeFileSync(
      join(srcDir, 'proc', 'SKILL.md'),
      'Use exarchos:exarchos_view and review.\n',
    );
    writeRuntimeFixtures(runtimesDir);
    buildAllSkills({ srcDir, outDir, runtimesDir });

    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: GIT_ENV });
    await execFileAsync('git', ['add', '-A'], { cwd: root, env: GIT_ENV });
    await execFileAsync('git', ['commit', '-q', '-m', 'seed'], { cwd: root, env: GIT_ENV });

    const standardFile = join(outDir, 'standard', 'proc', 'SKILL.md');
    expect(existsSync(standardFile)).toBe(true);
    writeFileSync(standardFile, readFileSync(standardFile, 'utf8') + '\n<!-- hand edit -->\n');
    await execFileAsync('git', ['add', '-A'], { cwd: root, env: GIT_ENV });
    await execFileAsync('git', ['commit', '-q', '-m', 'drift standard'], { cwd: root, env: GIT_ENV });

    const result = runSkillsGuard({ cwd: root, regenerateAgents: () => {} });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toMatch(/rendered\/skills\/standard\/proc\/SKILL\.md/);
  });

  /** The CHAIN target is not a canonical verb and not a skill on disk. */
  it('chainToken_TargetSkillMissing_FailsBuild', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'content');
    const outDir = join(root, 'skills');
    const runtimesDir = join(root, 'content/harness/runtimes');
    mkdirSync(join(srcDir, 'chainer'), { recursive: true });
    writeFileSync(
      join(srcDir, 'chainer', 'SKILL.md'),
      'Then run {{CHAIN next="totally-bogus-nonexistent-verb" args="$X"}}.\n',
    );
    writeRuntimeFixtures(runtimesDir);

    let err: unknown;
    try {
      buildAllSkills({ srcDir, outDir, runtimesDir });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/CHAIN target/i);
    expect(message).toContain('totally-bogus-nonexistent-verb');
  });
});
